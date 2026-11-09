import Foundation
import XCTest
@testable import IAMCEO

/// Every request is intercepted by IsolatedTestNetwork; no daemon, provider home or OS credentials.
final class ManagementNavigationServer: @unchecked Sendable {
    static let serverID = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
    let lock = NSRecursiveLock()
    var projects = ["hq": Project(id: "hq", name: "HQ", isHq: true),
                    "p": Project(id: "p", name: "Project", cwd: "/fixture/p"),
                    "q": Project(id: "q", name: "Other"),
                    "a": Project(id: "a", name: "Archive", archived: true)]
    var member = Member(id: "m", projectId: "p", kind: "worker", backend: "core", status: "idle",
                        sessionId: "native-session", paneId: "pane", contextState: CoreContextState())
    var decision = Decision(id: "d", projectId: "q", status: "answered")
    var anchor = Message(id: "old", projectId: "q", at: "old", memberId: "m", body: "old report")
    var patchStatus: Int?
    var losePatchResponse = false
    var applyPatch = true
    var loseCompactResponse = false
    var compactCalls = 0
    var archiveStatus: Int?
    var pushStatus = 200
    var revokeStatus = 200
    var revocations = 0
    var targetStatus = 200
    var aroundStatus = 200
    var target: PushTarget = .inbox(projectId: "q", decisionId: "d")
    var bootstrapStateRace = false
    var blockedPath: String?
    var entered: XCTestExpectation?
    var gate: DispatchSemaphore?
    func change(_ body: (ManagementNavigationServer) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (ManagementNavigationServer) -> T) -> T { lock.withLock { body(self) } }
    func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply { IsolatedTestHTTPReply(data: try JSONEncoder().encode(value)) }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        let path = request.url!.path
        let response = try response(request)
        if path == blockedPath, let gate {
            self.gate = nil; blockedPath = nil
            let entered = entered
            lock.unlock(); entered?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out"); lock.lock()
        }
        return response
    }
    private func response(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        let path = request.url!.path
        if path == "/api/bootstrap" {
            return try reply(Bootstrap(projects: ["p", "hq", "q"].compactMap { id in
                guard let project = projects[id], !project.archived else { return nil }
                return ProjectSummary(id: id, name: project.name, isHq: project.isHq, cwd: project.cwd)
            }))
        }
        if path == "/api/capabilities" || path == "/api/runtime" { return IsolatedTestHTTPReply(status: 404) }
        if path == "/api/push/status" {
            if pushStatus != 200 { return IsolatedTestHTTPReply(status: pushStatus) }
            return try reply(PushStatus(serverId: Self.serverID, supported: true, providers: []))
        }
        if path == "/api/push/devices" { return try reply(PushDeviceList(devices: [])) }
        if path.hasPrefix("/api/push/devices/") {
            if request.httpMethod == "DELETE" {
                revocations += 1
                return IsolatedTestHTTPReply(status: revokeStatus, data: Data(#"{"ok":true}"#.utf8))
            }
            return IsolatedTestHTTPReply(status: 404)
        }
        if path.contains("/api/push/events/") {
            if targetStatus != 200 { return IsolatedTestHTTPReply(status: targetStatus) }
            return try reply(PushEventTarget(serverId: Self.serverID, eventId: request.url!.pathComponents.dropLast().last!, target: target, reportGroup: nil))
        }
        if path == "/api/decisions/d" { return try reply(decision) }
        if path == "/api/projects/archived" {
            if let archiveStatus { return IsolatedTestHTTPReply(status: archiveStatus) }
            return try reply(projects.values.filter(\.archived).sorted { $0.id < $1.id })
        }
        if path == "/api/members/m/compact" {
            compactCalls += 1
            member.contextState?.compaction = ContextCompaction(id: "compact-1", trigger: "manual", phase: .queued, reason: "working")
            if loseCompactResponse { throw URLError(.timedOut) }
            return try reply(member)
        }
        let components = request.url!.pathComponents
        if components.count >= 4, components[1] == "api", components[2] == "projects", let project = projects[components[3]] {
            let id = project.id
            if request.httpMethod == "PATCH" {
                if let patchStatus { return IsolatedTestHTTPReply(status: patchStatus) }
                let body = try WriteTestServer.body(request)
                if applyPatch {
                    if let name = body["name"] as? String { projects[id]?.name = name.trimmingCharacters(in: .whitespacesAndNewlines) }
                    if let cwd = body["cwd"] as? String { projects[id]?.cwd = cwd }
                    if let archived = body["archived"] as? Bool { projects[id]?.archived = archived }
                }
                if losePatchResponse { throw URLError(.timedOut) }
                return try reply(projects[id]!)
            }
            if path.hasSuffix("/state") {
                let archive = path.contains("/archive/")
                if bootstrapStateRace, id == "p", !archive {
                    bootstrapStateRace = false; projects[id]?.archived = true
                    return IsolatedTestHTTPReply(status: 404)
                }
                guard project.archived == archive else { return IsolatedTestHTTPReply(status: 404) }
                var scopedMember = member; scopedMember.projectId = id
                return try reply(ProjectState(project: project, members: [Member(id: "lead", projectId: id, kind: "conductor"), scopedMember],
                    decisions: [Decision(id: "d", projectId: id)], todos: [Todo(id: "t", projectId: id)], files: [FileDoc(id: "f", projectId: id)]))
            }
            if path.hasSuffix("/messages/page") {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
                let scope: MessageScope = query.first { $0.name == "scope" }?.value == "member"
                    ? .member(memberId: query.first { $0.name == "memberId" }!.value!) : .project
                return try reply(MessagePage(projectId: id, scope: scope, items: [Message(id: "tail", projectId: id, at: "z", memberId: "m")], nextCursor: nil, hasOlder: false))
            }
            if path.hasSuffix("/messages") {
                if aroundStatus != 200 { return IsolatedTestHTTPReply(status: aroundStatus) }
                return try reply([anchor])
            }
        }
        return IsolatedTestHTTPReply(status: 404)
    }
}

@MainActor final class ProjectManageTests: XCTestCase {
    func connected(_ network: IsolatedTestNetwork, storage: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, writeStorageURL: storage)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        // This fixture's scenarios operate on p; first launch now correctly defaults to HQ.
        await store.selectProject(id: "p")
        return store
    }
    func testRenamePreservesIdentityDraftHistoryAndManagementSheet() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let router = Router(); store.registerRouter(router); router.manageProject(id: "p", mode: .rename)
        let key = DraftStore.key(project: "p", target: "m")
        store.drafts.setText("keep", for: key)
        await store.activateHistory()
        let historyKey = store.histories.activeKey
        let result = await store.patchProject(id: "p", request: PatchProjectRequest(name: " Renamed "))
        XCTAssertTrue(result)
        XCTAssertEqual(store.selectedProjectID, "p")
        XCTAssertEqual(store.state?.project.name, "Renamed")
        XCTAssertEqual(store.state?.project.cwd, "/fixture/p")
        XCTAssertEqual(store.drafts.text(for: key), "keep")
        XCTAssertEqual(store.histories.activeKey, historyKey)
        XCTAssertEqual(router.projectManagement?.projectID, "p")
        let request = try XCTUnwrap(network.requests.first { $0.httpMethod == "PATCH" })
        XCTAssertEqual(request.timeoutInterval, 150)
        XCTAssertNil(try WriteTestServer.body(request)["cwd"])
    }
    func testArchiveCurrentReturnsToHQAndPreservesOriginalDraft() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let router = Router(); store.registerRouter(router)
        router.showNewMember = true; router.terminalMemberID = "m"
        let key = DraftStore.key(project: "p", target: "m"); store.drafts.setText("keep", for: key)
        let result = await store.patchProject(id: "p", request: PatchProjectRequest(archived: true))
        XCTAssertTrue(result)
        XCTAssertEqual(store.selectedProjectID, "hq")
        XCTAssertFalse(router.showNewMember); XCTAssertNil(router.terminalMemberID)
        XCTAssertEqual(store.drafts.text(for: key), "keep")
        XCTAssertTrue(store.archivedProjects.contains { $0.id == "p" })
        XCTAssertFalse(store.projects.contains { $0.id == "p" })
    }
    func testOtherProjectRestoreDoesNotNavigateAndArchiveRemainsReadable() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let restored = await store.patchProject(id: "a", request: PatchProjectRequest(archived: false))
        XCTAssertTrue(restored); XCTAssertEqual(store.selectedProjectID, "p")
        _ = await store.patchProject(id: "a", request: PatchProjectRequest(archived: true))
        await store.selectArchivedProject(id: "a")
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(store.decisions.map(\.id), ["d"])
        XCTAssertEqual(store.todos.map(\.id), ["t"])
        XCTAssertEqual(store.files.map(\.id), ["f"])
        await store.activateHistory()
        XCTAssertEqual(store.historyMessages.map(\.id), ["tail"])
        let before = network.requests.count
        _ = await store.sendMessage(text: "blocked")
        _ = await store.memberAction(store.members[1], action: "compact")
        XCTAssertEqual(network.requests.count, before)
        let renamed = await store.patchProject(id: "a", request: PatchProjectRequest(name: "Archived rename"))
        XCTAssertTrue(renamed)
    }
    func testSharedProjectPendingSpansResponseAndReconciliation() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let entered = expectation(description: "patch in flight"), gate = DispatchSemaphore(value: 0)
        server.change { $0.blockedPath = "/api/projects/p"; $0.gate = gate; $0.entered = entered }
        let task = Task { await store.patchProject(id: "p", request: PatchProjectRequest(name: "One")) }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertTrue(store.pendingActions.contains("project:p"))
        let duplicate = await store.patchProject(id: "p", request: PatchProjectRequest(archived: true))
        XCTAssertFalse(duplicate)
        gate.signal(); _ = await task.value
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "PATCH" }.count, 1)
        XCTAssertFalse(store.pendingActions.contains("project:p"))
    }
    func testLostResponseRequeriesWithoutReplayingAndRetainsCheckingAcrossRestart() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("iamceo-w8n-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = directory.appendingPathComponent("writes.json")
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        var store = await connected(network, storage: storage)
        server.change { $0.losePatchResponse = true; $0.applyPatch = false }
        let result = await store.patchProject(id: "p", request: PatchProjectRequest(archived: true))
        XCTAssertFalse(result); XCTAssertEqual(store.projectResults["p"], .checking); XCTAssertFalse(store.canWrite)
        let duplicate = await store.patchProject(id: "p", request: PatchProjectRequest(name: "retry"))
        XCTAssertFalse(duplicate)
        store.disconnect()
        store = await connected(network, storage: storage)
        XCTAssertEqual(store.projectResults["p"], .checking)
        XCTAssertFalse(store.canWrite)
        server.change { $0.projects["p"]?.archived = true }
        await store.recheckProject(id: "p")
        XCTAssertEqual(store.projectResults["p"], .current); XCTAssertEqual(store.selectedProjectID, "hq")
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "PATCH" }.count, 1)
        store.disconnect()
    }
    func testCommittedPatchResponseLossIsCurrentStateNotClaimedSuccess() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        server.change { $0.losePatchResponse = true }
        let result = await store.patchProject(id: "p", request: PatchProjectRequest(name: "Changed"))
        XCTAssertFalse(result); XCTAssertEqual(store.projectResults["p"], .current)
        XCTAssertEqual(store.state?.project.name, "Changed")
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "PATCH" }.count, 1)
    }
    func testRefusalArchiveLoadFailureAndHQGuard() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        await store.loadArchivedProjects()
        server.change { $0.patchStatus = 409; $0.archiveStatus = 503 }
        let result = await store.patchProject(id: "q", request: PatchProjectRequest(archived: true))
        XCTAssertFalse(result); XCTAssertEqual(store.projectResults["q"], .refused)
        XCTAssertNotNil(store.archiveError); XCTAssertFalse(store.isLoadingArchive)
        XCTAssertEqual(store.archivedProjects.map(\.id), ["a"])
        let count = network.requests.count
        _ = await store.patchProject(id: "hq", request: PatchProjectRequest(archived: true))
        XCTAssertEqual(network.requests.count, count)
    }
    func testBootstrapStateArchiveRaceRecoversToHQ() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        server.change { $0.bootstrapStateRace = true }
        let store = await connected(network); defer { store.disconnect() }
        // Fallback selection is scheduled outside the snapshot single flight.
        for _ in 0..<30 where store.selectedProjectID != "hq" { await Task.yield() }
        XCTAssertEqual(store.selectedProjectID, "hq")
        XCTAssertFalse(store.projects.contains { $0.id == "p" })
    }
    func testCompactionAcceptanceAndLostResponseNeverReplay() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        server.change { $0.loseCompactResponse = true }
        let member = try XCTUnwrap(store.members.first { $0.id == "m" })
        let result = await store.compactMember(member)
        XCTAssertFalse(result); XCTAssertTrue(store.contextChecking.contains("m"))
        _ = await store.compactMember(member)
        XCTAssertEqual(server.read { $0.compactCalls }, 1)
        server.change { $0.member.contextState?.compaction?.phase = .succeeded }
        await store.refresh()
        XCTAssertFalse(store.contextChecking.contains("m"))
        XCTAssertEqual(server.read { $0.compactCalls }, 1)
    }
    func testLatePatchCannotApplyToNewHostOrResetItsRouter() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network)
        let router = Router(); store.registerRouter(router); router.manageProject(id: "p", mode: .rename)
        let entered = expectation(description: "patch held"), gate = DispatchSemaphore(value: 0)
        server.change { $0.blockedPath = "/api/projects/p"; $0.gate = gate; $0.entered = entered }
        let task = Task { await store.patchProject(id: "p", request: PatchProjectRequest(name: "Late")) }
        await fulfillment(of: [entered], timeout: 3)
        store.disconnect(); XCTAssertNil(router.projectManagement)
        gate.signal()
        let result = await task.value
        XCTAssertFalse(result); XCTAssertNil(store.state); XCTAssertTrue(store.archivedProjects.isEmpty)
    }

    func testCompactionQueuedIsAcceptedAndManualOrUnidentifiedSessionsNeverSubmit() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let accepted = await store.compactMember(store.members[1])
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.members[1].contextState?.compaction?.phase, .queued)
        _ = await store.compactMember(store.members[1])
        XCTAssertEqual(server.read { $0.compactCalls }, 1)
        server.change { $0.member.contextState?.compaction?.phase = .failed; $0.member.origin = "manual" }
        await store.refresh()
        _ = await store.compactMember(store.members[1])
        server.change { $0.member.origin = "runner"; $0.member.sessionId = nil }
        await store.refresh()
        _ = await store.compactMember(store.members[1])
        XCTAssertEqual(server.read { $0.compactCalls }, 1)
    }

    func testArchiveAcknowledgementInBackgroundDoesNotStartFollowupReads() async throws {
        let server = ManagementNavigationServer(), network = try IsolatedTestNetwork { try server.handle($0) }
        let store = await connected(network); defer { store.disconnect() }
        let entered = expectation(description: "archive response held"), gate = DispatchSemaphore(value: 0)
        server.change { $0.blockedPath = "/api/projects/p"; $0.gate = gate; $0.entered = entered }
        let task = Task { await store.patchProject(id: "p", request: PatchProjectRequest(archived: true)) }
        await fulfillment(of: [entered], timeout: 3)
        store.setForeground(false)
        let before = network.requests.count
        gate.signal()
        let accepted = await task.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(network.requests.count, before)
        XCTAssertEqual(store.selectedProjectID, "hq"); XCTAssertNil(store.state)
        XCTAssertFalse(store.canWrite)
    }
}
