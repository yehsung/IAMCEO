import Foundation
import XCTest
@testable import IAMCEO

@MainActor private final class NavigationPushOS: PushAuthorizationProvider {
    var onToken: (@MainActor @Sendable (Data, UUID) -> Void)?
    var onFailure: (@MainActor @Sendable (UUID) -> Void)?
    var reads = 0
    var prompts = 0
    var registrations = 0
    var cleared: [String] = []
    func settings() -> PushSystemSettings {
        reads += 1
        return PushSystemSettings(authorization: .authorized, alertsEnabled: true, soundsEnabled: true)
    }
    func requestAuthorization() { prompts += 1 }
    func register(generation: UUID) -> Bool { registrations += 1; return true }
    func cancelPendingRegistration() {}
    func clearDelivered(serverID: String) { cleared.append(serverID) }
}

@MainActor final class NotificationNavigationTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork, push: PushNotificationService? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, pushNotifications: push)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        // This fixture's scenarios operate on p; first launch now correctly defaults to HQ.
        await store.selectProject(id: "p")
        return store
    }
    private func link(_ target: PushTarget, event: String = UUID().uuidString, server: String = ManagementNavigationServer.serverID) throws -> NotificationLink {
        let kind: String
        switch target { case .home: kind = "test"; case .projectHome: kind = "todo_created"; case .inbox: kind = "decision"; case .team: kind = "error"; default: kind = "report_complete" }
        return try XCTUnwrap(NotificationLink.parse(metadata: JSONEncoder().encode(PushNotificationMetadata(
            v: 1, serverId: server, eventId: event, kind: kind, target: target))))
    }

    func testTodoTapValidatesProjectAndOpensItsHomeWithoutWriting() async throws {
        for id in ["q", "a", "missing", "wrong-state"] {
            let server = ManagementNavigationServer()
            server.change { $0.target = .projectHome(projectId: id) }
            let network = try IsolatedTestNetwork { request in
                if request.url?.path == "/api/projects/wrong-state/state" {
                    return try server.reply(ProjectState(project: Project(id: "q")))
                }
                return try server.handle(request)
            }
            let store = await connect(network), router = Router(destination: .chat), inbox = NotificationInbox()
            defer { store.disconnect() }
            inbox.receive(try link(.projectHome(projectId: id)), tapped: true)
            await store.processNotifications(router: router, inbox: inbox)
            router.resetForProjectChange()
            XCTAssertEqual(router.destination, .home)
            XCTAssertEqual(store.selectedProjectID, id == "q" ? "q" : "p")
            XCTAssertEqual(store.state?.project.id, id == "q" ? "q" : "p")
            XCTAssertNil(router.decisionID); XCTAssertNil(router.terminalMemberID)
            if id != "q" { XCTAssertNotNil(store.notificationNotice) }
            XCTAssertTrue(network.requests.allSatisfy { $0.httpMethod == "GET" })
            await network.close()
        }
    }

    func testBlockedReportTapOpensOriginalChatWithoutAnswerOrInput() async throws {
        let server = ManagementNavigationServer()
        let target = PushTarget.chat(projectId: "q", memberId: "m", messageId: "old")
        server.change { $0.target = target }
        let network = try IsolatedTestNetwork(handler: server.handle), store = await connect(network)
        defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router()
        let notification = try XCTUnwrap(NotificationLink.parse(metadata: JSONEncoder().encode(PushNotificationMetadata(
            v: 1, serverId: ManagementNavigationServer.serverID, eventId: UUID().uuidString,
            kind: "report_blocked", target: target))))
        inbox.receive(notification, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        router.resetForProjectChange()
        XCTAssertEqual(store.selectedProjectID, "q"); XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "m"); XCTAssertEqual(router.chatMessageID, "old")
        XCTAssertTrue(network.requests.allSatisfy { $0.httpMethod == "GET" })
        await network.close()
    }

    func testColdStartTapAppliesOnlyAfterProjectResetAndOnlyOneWindowConsumes() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let inbox = NotificationInbox(), first = Router(), second = Router()
        inbox.receive(try link(.inbox(projectId: "q", decisionId: "d")), tapped: true)
        let store = await connect(network); defer { store.disconnect() }
        await store.processNotifications(router: first, inbox: inbox)
        XCTAssertEqual(store.selectedProjectID, "q")
        XCTAssertNil(first.decisionID, "SwiftUI has not delivered its project reset yet")
        first.resetForProjectChange()
        XCTAssertEqual(first.destination, .inbox); XCTAssertEqual(first.decisionID, "d")
        XCTAssertEqual(first.navigationNotice, "이미 처리된 결재입니다.")
        await store.processNotifications(router: second, inbox: inbox)
        XCTAssertNil(second.decisionID); XCTAssertTrue(inbox.pending.isEmpty)
        first.resetForProjectChange()
        XCTAssertNil(first.decisionID, "The pending route is consumed once")
    }
    func testResetDeliveredDuringSelectionAndUserNavigationCancelsPendingRoute() async throws {
        let router = Router()
        let reset = router.projectResetRevision
        router.resetForProjectChange()
        router.applyNotification(NotificationRoute(target: .team(projectId: "q", memberId: "m")), afterProjectChange: true, resetRevision: reset)
        XCTAssertEqual(router.memberID, "m")
        router.applyNotification(NotificationRoute(target: .inbox(projectId: "q", decisionId: "d")), afterProjectChange: true, resetRevision: router.projectResetRevision)
        router.go(.files)
        router.resetForProjectChange()
        XCTAssertEqual(router.destination, .files); XCTAssertNil(router.decisionID)
        router.showNewMember = true; router.resetForProjectChange(); XCTAssertFalse(router.showNewMember)
        router.terminalMemberID = "old"; router.showSettings = true
        router.applyNotification(NotificationRoute(target: .inbox(projectId: "q", decisionId: "d")), afterProjectChange: false, resetRevision: router.projectResetRevision)
        XCTAssertNil(router.terminalMemberID); XCTAssertFalse(router.showSettings)
        XCTAssertEqual(router.decisionID, "d")
    }
    func testForegroundReceiptRefreshesWithoutNavigationAndForeignHostDoesNotSwitch() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connect(network); defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router(destination: .files)
        inbox.receive(try link(.inbox(projectId: "q", decisionId: "d")), tapped: false)
        let before = network.requests.filter { $0.url?.path == "/api/bootstrap" }.count
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertGreaterThan(network.requests.filter { $0.url?.path == "/api/bootstrap" }.count, before)
        XCTAssertEqual(router.destination, .files); XCTAssertEqual(store.selectedProjectID, "p")
        let endpoint = store.endpoint
        inbox.receive(try link(.team(projectId: "q", memberId: "m"), server: UUID().uuidString), tapped: true)
        let count = network.requests.count
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(network.requests.count, count); XCTAssertEqual(store.endpoint, endpoint)
        XCTAssertEqual(inbox.pending.count, 1); XCTAssertEqual(store.notificationNotice, "이 알림의 호스트에 연결해 주세요.")
        XCTAssertEqual(store.knownServerEndpoints[ManagementNavigationServer.serverID], network.endpoint.url.absoluteString)
    }
    func testOldReportUsesAuthoritativeThreadAndSeparateAroundInterval() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        server.change { $0.target = .chat(projectId: "q", memberId: "wrong-hint", messageId: "old") }
        let store = await connect(network); defer { store.disconnect() }
        await store.selectProject(id: "q"); await store.activateHistory(targetMemberID: "m")
        let key = DraftStore.key(project: "q", target: "m"); store.drafts.setText("untouched", for: key)
        let history = try XCTUnwrap(store.history)
        let inbox = NotificationInbox(), router = Router()
        inbox.receive(try link(.chat(projectId: "q", memberId: "wrong-hint", messageId: "old")), tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(router.chatTarget, "m"); XCTAssertEqual(router.chatMessageID, "old")
        XCTAssertEqual(store.notificationMessages.map(\.id), ["old"])
        XCTAssertEqual(store.history?.items.map(\.id), history.items.map(\.id))
        XCTAssertEqual(store.historyMessages.map(\.id), ["old"])
        XCTAssertEqual(store.drafts.text(for: key), "untouched")
        XCTAssertEqual(store.messages.count, 0, "The snapshot's recent messages were not replaced by around")
        store.leaveNotificationAnchor()
        XCTAssertEqual(store.historyMessages.map(\.id), ["tail"])
        XCTAssertFalse(network.requests.contains { $0.httpMethod == "POST" })
    }
    func testConductorReportTargetsProjectConversation() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        server.change { $0.target = .chat(projectId: "q", memberId: "m", messageId: "old"); $0.anchor.memberId = "lead" }
        let store = await connect(network); defer { store.disconnect() }
        await store.selectProject(id: "q")
        let inbox = NotificationInbox(), router = Router()
        inbox.receive(try link(.chat(projectId: "q", memberId: "m", messageId: "old")), tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertNil(router.chatTarget); XCTAssertEqual(router.chatMessageID, "old")
    }
    func testTransientTargetFailureRetriesReadButPermanentAndArchivedTargetsEnd() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connect(network); defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router()
        let notification = try link(.inbox(projectId: "q", decisionId: "d"))
        inbox.receive(notification, tapped: true)
        server.change { $0.targetStatus = 503 }
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertNil(router.decisionID)
        server.change { $0.targetStatus = 200 }
        await store.processNotifications(router: router, inbox: inbox)
        router.resetForProjectChange(); XCTAssertEqual(router.decisionID, "d")
        let requests = network.requests.filter { $0.url?.path.contains("/api/push/events/") == true }.count
        inbox.receive(notification, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(network.requests.filter { $0.url?.path.contains("/api/push/events/") == true }.count, requests)
        inbox.receive(try link(.inbox(projectId: "a", decisionId: "d")), tapped: true)
        server.change { $0.target = .inbox(projectId: "a", decisionId: "d") }
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(store.selectedProjectID, "q"); XCTAssertNotNil(store.notificationNotice)
        let count = network.requests.count
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(network.requests.count, count)
    }
    func testManualURLValidatesMembershipAndMissingReportFallsBackToChat() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connect(network); defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router()
        let bad = try XCTUnwrap(NotificationLink(url: URL(string: "iamceo://open/\(ManagementNavigationServer.serverID)/projects/p/decisions/d")!))
        inbox.receive(bad, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertNil(router.decisionID); XCTAssertEqual(store.selectedProjectID, "p")
        server.change { $0.aroundStatus = 404; $0.target = .chat(projectId: "q", memberId: nil, messageId: "deleted") }
        inbox.receive(try link(.chat(projectId: "q", memberId: nil, messageId: "deleted")), tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        router.resetForProjectChange()
        XCTAssertEqual(router.destination, .chat); XCTAssertNil(router.chatMessageID)
        XCTAssertEqual(router.navigationNotice, "보고를 찾을 수 없습니다.")
    }
    func testTwoConcurrentScenesAndUserProjectSwitchDuringValidation() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connect(network); defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router(), other = Router()
        let notification = try link(.inbox(projectId: "q", decisionId: "d"))
        inbox.receive(notification, tapped: true)
        let entered = expectation(description: "target held"), gate = DispatchSemaphore(value: 0)
        let path = "/api/push/events/\(notification.eventID!)/target"
        server.change { $0.blockedPath = path; $0.gate = gate; $0.entered = entered }
        let task = Task { await store.processNotifications(router: router, inbox: inbox) }
        await fulfillment(of: [entered], timeout: 3)
        await store.processNotifications(router: other, inbox: inbox)
        await store.selectProject(id: "hq")
        gate.signal(); await task.value
        router.resetForProjectChange()
        XCTAssertEqual(store.selectedProjectID, "hq"); XCTAssertNil(router.decisionID); XCTAssertNil(other.decisionID)
        XCTAssertEqual(network.requests.filter { $0.url?.path == path }.count, 1)
    }
    func testPushConnectionForegroundLogoutAndPendingRevocationRecovery() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let os = NavigationPushOS(), push = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        let store = await connect(network, push: push)
        XCTAssertEqual(store.serverID, ManagementNavigationServer.serverID)
        XCTAssertNotNil(push.settingsStore.host); XCTAssertEqual(os.prompts, 0); XCTAssertEqual(os.registrations, 0)
        await push.enable()
        XCTAssertEqual(os.prompts, 0); XCTAssertEqual(os.registrations, 1)
        let before = os.reads
        await store.refreshPushConnection()
        XCTAssertGreaterThan(os.reads, before)
        server.change { $0.revokeStatus = 503 }
        await store.logout()
        XCTAssertNil(store.api); XCTAssertNil(store.serverID); XCTAssertNil(push.settingsStore.host)
        XCTAssertEqual(store.pendingPushRevocations, [ManagementNavigationServer.serverID])
        server.change { $0.revokeStatus = 200 }
        store.accessCode = "fixture"; await store.connect()
        XCTAssertTrue(store.pendingPushRevocations.isEmpty)
        XCTAssertEqual(os.cleared, [ManagementNavigationServer.serverID])
        XCTAssertEqual(os.prompts, 0)
        await store.logout()
    }
    func testPushUnsupportedDoesNotBreakConnectionAndBackgroundAndDemoDoNoDiscovery() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        server.change { $0.pushStatus = 404 }
        let store = await connect(network); defer { store.disconnect() }
        XCTAssertEqual(store.connectionStatus, .connected); XCTAssertTrue(store.canWrite)
        XCTAssertNil(store.serverID)
        XCTAssertEqual(store.pushConnectionError, .unsupported)
        store.setForeground(false)
        let before = network.requests.count
        await store.refreshPushConnection(); await store.processNotifications(router: Router())
        XCTAssertEqual(network.requests.count, before)
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false)
        await demo.refreshPushConnection(); await demo.processNotifications(router: Router())
        XCTAssertEqual(network.requests.count, before)
    }

    func testUserChangesScreenDuringTargetReadAndMalformedAroundNeverNavigate() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connect(network); defer { store.disconnect() }
        let inbox = NotificationInbox(), router = Router()
        let notification = try link(.inbox(projectId: "q", decisionId: "d"))
        inbox.receive(notification, tapped: true)
        let entered = expectation(description: "validation held"), gate = DispatchSemaphore(value: 0)
        server.change {
            $0.blockedPath = "/api/push/events/\(notification.eventID!)/target"; $0.gate = gate; $0.entered = entered
        }
        let task = Task { await store.processNotifications(router: router, inbox: inbox) }
        await fulfillment(of: [entered], timeout: 3)
        router.go(.files); gate.signal(); await task.value
        XCTAssertEqual(store.selectedProjectID, "p"); XCTAssertEqual(router.destination, .files)
        server.change { $0.target = .chat(projectId: "q", memberId: "m", messageId: "old"); $0.anchor.projectId = "p" }
        inbox.receive(try link(.chat(projectId: "q", memberId: "m", messageId: "old")), tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(store.selectedProjectID, "p"); XCTAssertNil(router.chatMessageID)
        let count = network.requests.count
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(network.requests.count, count, "Malformed target is terminal, not a permanent retry loop")
    }

    func testTapWaitsForConnectionAnd401EndsItsPendingNavigation() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = AppStore(session: network.session, persistCredentials: false)
        let inbox = NotificationInbox(), router = Router()
        inbox.receive(try link(.inbox(projectId: "q", decisionId: "d")), tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(inbox.pending.count, 1); XCTAssertTrue(network.requests.isEmpty)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"; await store.connect()
        server.change { $0.targetStatus = 401 }
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(store.connectionStatus, .failed); XCTAssertNil(store.api); XCTAssertNil(store.serverID)
        XCTAssertTrue(inbox.pending.isEmpty); XCTAssertNil(router.decisionID)
    }
}
