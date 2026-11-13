import Foundation
import Observation
import XCTest
#if os(macOS)
import AppKit
#endif
@testable import IAMCEO

private final class ChurnCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func increment() { lock.withLock { value += 1 } }
}

/// Every HTTP request is intercepted; no daemon, credentials, defaults or socket is used.
private final class ChurnServer: @unchecked Sendable {
    private let lock = NSLock()
    private var seq = 0
    private var revision = 1
    private var epoch = "churn"
    private var realtime = true
    private var unavailableProject: String?
    private var states = [
        "p": ProjectState(project: Project(id: "p", name: "Project P"), members: [Member(id: "m", projectId: "p")]),
        "q": ProjectState(project: Project(id: "q", name: "Project Q"))
    ]
    private var syncReads = 0
    var syncCount: Int { lock.withLock { syncReads } }

    func advanceCursor() { lock.withLock { seq += 1 } }
    func advanceRevision() { lock.withLock { revision += 1 } }
    func replaceEpoch() { lock.withLock { epoch = "replacement"; seq = 0 } }
    func useLegacy() { lock.withLock { realtime = false } }
    func fail(project: String) { lock.withLock { unavailableProject = project } }
    func changeProject(_ change: (inout ProjectState) -> Void) { lock.withLock { change(&states["p"]!) } }

    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            func reply<Value: Encodable>(_ value: Value) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
            }
            let bootstrap = Bootstrap(projects: [ProjectSummary(id: "p"), ProjectSummary(id: "q")])
            let path = request.url!.path
            switch path {
            case "/api/bootstrap": return try reply(bootstrap)
            case "/api/capabilities":
                return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(realtime: realtime)))
            case "/api/runtime": return try reply(RuntimeDiagnostics())
            case "/api/projects/p/state", "/api/projects/q/state":
                return try reply(states[path.contains("/p/") ? "p" : "q"]!)
            case "/api/sync":
                syncReads += 1
                let project = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
                    .first { $0.name == "projectId" }?.value
                if let project, project == unavailableProject { return IsolatedTestHTTPReply(status: 503) }
                return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: epoch, seq: seq),
                    requestedProjectId: project, projectStatus: project == nil ? .none : .ok,
                    bootstrap: bootstrap, state: project.flatMap { states[$0] }, revisions: SyncRevisions(settings: revision)))
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
    }
}

/// The probe runs inside the same detached encoder used for ProjectState, called from MainActor below.
private struct ChurnEncodingProbe: Encodable, Sendable {
    func encode(to encoder: any Encoder) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var container = encoder.singleValueContainer()
        try container.encode(Thread.isMainThread)
    }
}

@MainActor final class AppChurnTests: XCTestCase {
    private func connect(_ server: ChurnServer) async throws -> (AppStore, IsolatedTestNetwork) {
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false, lowPowerMode: false)
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture"
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.selectedProjectID, "p")
        return (store, network)
    }

    func testIdenticalSnapshotsDoNotAssignStateOrBootstrap() async throws {
        let server = ChurnServer()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        let stateChanges = ChurnCounter(), bootstrapChanges = ChurnCounter()
        withObservationTracking { _ = store.state } onChange: { stateChanges.increment() }
        withObservationTracking { _ = store.bootstrap } onChange: { bootstrapChanges.increment() }
        let before = server.syncCount
        let clock = ContinuousClock(), start = clock.now
        for _ in 0..<3 { await store.refresh() }
        XCTAssertEqual(server.syncCount - before, 3, "Exercise actual /sync application, not a no-op refresh")
        XCTAssertEqual(stateChanges.count, 0)
        XCTAssertEqual(bootstrapChanges.count, 0)
        print("app-churn: 3 repeated /sync snapshots, 0 state assignments, elapsed \(start.duration(to: clock.now))")
    }

    func testNewCursorWithEqualPayloadStillDoesNotAssignAndRevisionChangeDoes() async throws {
        let server = ChurnServer()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        let changes = ChurnCounter()
        withObservationTracking { _ = store.state } onChange: { changes.increment() }
        server.advanceCursor()
        await store.refresh()
        XCTAssertEqual(store.appliedSnapshotCursor?.seq, 1)
        XCTAssertEqual(changes.count, 0)
        // A revision change must apply even when the host cursor has not advanced.
        server.changeProject { $0.project.name = "Revised" }
        server.advanceRevision()
        await store.refresh()
        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(store.currentProjectName, "Revised")
    }

    func testOnlyChangedCollectionNotifiesItsObservers() async throws {
        let server = ChurnServer()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        let members = ChurnCounter(), messages = ChurnCounter(), files = ChurnCounter()
        withObservationTracking { _ = store.members } onChange: { members.increment() }
        withObservationTracking { _ = store.messages } onChange: { messages.increment() }
        withObservationTracking { _ = store.files } onChange: { files.increment() }
        server.changeProject { $0.messages.append(Message(id: "new", projectId: "p", body: "hello")) }
        server.advanceCursor()
        await store.refresh()
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(members.count, 0)
        XCTAssertEqual(files.count, 0)
        XCTAssertEqual(store.messages, store.state?.messages)
    }

    private func assertModelFieldChangeApplies<Model: Equatable>(
        _ keyPath: WritableKeyPath<ProjectState, Model>,
        change: (inout Model) -> Void,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let server = ChurnServer()
        server.changeProject {
            $0.messages = [Message(id: "message", projectId: "p")]
            $0.files = [FileDoc(id: "file", projectId: "p")]
        }
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        let original = try XCTUnwrap(store.state, file: file, line: line)
        var changed = original
        change(&changed[keyPath: keyPath])
        XCTAssertNotEqual(original[keyPath: keyPath], changed[keyPath: keyPath], file: file, line: line)
        XCTAssertNotEqual(original, changed, file: file, line: line)

        let assignments = ChurnCounter()
        withObservationTracking { _ = store.state } onChange: { assignments.increment() }
        server.changeProject { $0 = changed }
        server.advanceCursor()
        let reads = server.syncCount
        await store.refresh()
        XCTAssertEqual(server.syncCount - reads, 1, file: file, line: line)
        XCTAssertEqual(assignments.count, 1, file: file, line: line)
        XCTAssertEqual(store.state, changed, file: file, line: line)
        XCTAssertEqual(store.members, changed.members, file: file, line: line)
        XCTAssertEqual(store.messages, changed.messages, file: file, line: line)
        XCTAssertEqual(store.files, changed.files, file: file, line: line)

        // Once the changed snapshot is applied, its duplicate must cause no assignment.
        let duplicates = ChurnCounter()
        withObservationTracking { _ = store.state } onChange: { duplicates.increment() }
        await store.refresh()
        XCTAssertEqual(server.syncCount - reads, 2, file: file, line: line)
        XCTAssertEqual(duplicates.count, 0, file: file, line: line)
    }

    func testMemberSingleFieldChangeDiffersAndAppliesSnapshot() async throws {
        try await assertModelFieldChangeApplies(\ProjectState.members[0]) {
            $0.lastActiveAt = "2026-11-10T01:00:00Z"
        }
    }

    func testMessageSingleFieldChangeDiffersAndAppliesSnapshot() async throws {
        try await assertModelFieldChangeApplies(\ProjectState.messages[0]) {
            $0.deliveryRevision = 7
        }
    }

    func testFileDocSingleFieldChangeDiffersAndAppliesSnapshot() async throws {
        try await assertModelFieldChangeApplies(\ProjectState.files[0]) {
            $0.reused = true
        }
    }

    func testProjectStateSingleFieldChangeDiffersAndAppliesSnapshot() async throws {
        try await assertModelFieldChangeApplies(\ProjectState.self) {
            $0.doneDecisionCount = 1
        }
    }

    func testLegacyRepeatedPayloadUsesEqualityAndStillAppliesChanges() async throws {
        let server = ChurnServer()
        server.useLegacy()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        let changes = ChurnCounter()
        withObservationTracking { _ = store.state } onChange: { changes.increment() }
        await store.refresh()
        XCTAssertEqual(changes.count, 0)
        server.changeProject { $0.project.name = "Legacy update" }
        await store.refresh()
        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(store.currentProjectName, "Legacy update")
    }

    func testSameCursorAcrossProjectSwitchRestoresLatestCachedState() async throws {
        let server = ChurnServer()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        server.changeProject { $0.project.name = "Latest cached P" }
        server.advanceCursor()
        await store.refresh()
        await store.selectProject(id: "q")
        XCTAssertEqual(store.currentProjectName, "Project Q")
        server.fail(project: "p")
        await store.selectProject(id: "p")
        XCTAssertEqual(store.state?.project.id, "p")
        XCTAssertEqual(store.currentProjectName, "Latest cached P", "A failed network read preserves the serialized outgoing snapshot")
    }

    func testEpochReplacementAtSameSequenceApplies() async throws {
        let server = ChurnServer()
        let (store, network) = try await connect(server)
        defer { store.disconnect(); _ = network }
        server.changeProject { $0.project.name = "New host epoch" }
        server.replaceEpoch()
        await store.refresh()
        XCTAssertEqual(store.appliedSnapshotCursor?.epoch, "replacement")
        XCTAssertEqual(store.currentProjectName, "New host epoch")
    }

    func testEncodingCalledFromMainActorRunsOffMainQueueAndRoundTripsState() async throws {
        MainActor.preconditionIsolated()
        let probe = await ProjectStateCache.encode(ChurnEncodingProbe())
        XCTAssertFalse(try JSONDecoder().decode(Bool.self, from: XCTUnwrap(probe)))
        let state = DemoFixtures.workspace().1
        let encoded = await ProjectStateCache.encode(state)
        XCTAssertEqual(try JSONDecoder().decode(ProjectState.self, from: XCTUnwrap(encoded)), state)
    }

    func testDemoCollectionsAreInitializedAndNestedValuesParticipateInEquality() async throws {
        let store = AppStore(demo: true, persistCredentials: false)
        defer { store.prepareForReplacement() }
        try await waitWhile({ store.state == nil }, timeout: .seconds(15))
        XCTAssertFalse(store.members.isEmpty)
        XCTAssertEqual(store.members, store.state?.members)
        let original = DemoFixtures.workspace().1
        var changed = original
        changed.members[0].contextState = CoreContextState(measurement: ContextMeasurement(tokens: 42))
        XCTAssertNotEqual(changed, original)
        changed = original
        changed.messages.append(Message(id: "delivered", deliveryRevision: 7))
        XCTAssertNotEqual(changed, original)
    }

    #if os(macOS)
    func testNonKeyAndOccludedWindowsHaveOnlyOneTimelineEntry() {
        for (isKey, occlusion) in [(false, NSWindow.OcclusionState.visible), (true, []), (false, [])] {
            var cadence = OfficeCadence()
            cadence.paused = !OfficeAnimationVisibility.allowsAnimation(isKeyWindow: isKey, occlusionState: occlusion)
            var entries = cadence.entries(from: Date(), mode: .normal)
            XCTAssertNotNil(entries.next())
            XCTAssertNil(entries.next(), "A background office must not schedule further frames")
        }
        XCTAssertTrue(OfficeAnimationVisibility.allowsAnimation(isKeyWindow: true, occlusionState: .visible))
    }
    #endif
}
