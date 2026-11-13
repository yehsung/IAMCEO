import Foundation
import Observation
import XCTest
@testable import IAMCEO

private final class SliceCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func increment() { lock.withLock { value += 1 } }
}

/// Every HTTP request is intercepted; no daemon, credentials, defaults or socket is used.
private final class SliceServer: @unchecked Sendable {
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        func reply<Value: Encodable>(_ value: Value) throws -> IsolatedTestHTTPReply {
            IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
        }
        var project = Project(id: "p", name: "Project P")
        project.connection.ok = true
        let state = ProjectState(project: project, members: [Member(id: "m", projectId: "p", status: "idle")])
        let bootstrap = Bootstrap(projects: [ProjectSummary(id: "p")])
        switch request.url!.path {
        case "/api/bootstrap": return try reply(bootstrap)
        case "/api/capabilities":
            return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(realtime: true)))
        case "/api/runtime": return try reply(RuntimeDiagnostics())
        case "/api/projects/p/state": return try reply(state)
        case "/api/sync":
            return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: "slice", seq: 0), requestedProjectId: "p",
                                          projectStatus: .ok, bootstrap: bootstrap, state: state, revisions: SyncRevisions(settings: 1)))
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}

/// E7 §5: 쓰기 판정·제목·전달 안내는 `state` 전체가 아니라 프로젝트 머리 값만 읽는다.
/// 팀원 한 명의 상태가 바뀌어도 그 값을 읽는 화면은 다시 계산되지 않고, 머리 값이 바뀌면 그 값을 읽는 쪽만 알림을 받는다.
@MainActor final class StateSliceObservationTests: XCTestCase {
    func testMemberChangeLeavesWriteGateReadersAloneAndProjectHeadChangesReachOnlyTheirReaders() async throws {
        let network = try IsolatedTestNetwork(handler: SliceServer().handle)
        let store = AppStore(session: network.session, persistCredentials: false, lowPowerMode: false)
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture"
        await store.connect()
        defer { store.disconnect() }
        XCTAssertEqual(store.selectedProjectID, "p")
        XCTAssertTrue(store.canWrite)
        XCTAssertTrue(store.uiCanWrite)
        XCTAssertNil(store.writeBlockedReason)
        XCTAssertEqual(store.currentProjectName, "Project P")
        XCTAssertEqual(store.stateProjectID, "p")

        let gate = SliceCounter(), reason = SliceCounter(), ui = SliceCounter(), title = SliceCounter()
        let notices = SliceCounter(), members = SliceCounter()
        withObservationTracking { _ = store.canWrite } onChange: { gate.increment() }
        withObservationTracking { _ = store.writeBlockedReason } onChange: { reason.increment() }
        withObservationTracking { _ = store.uiCanWrite } onChange: { ui.increment() }
        withObservationTracking { _ = store.currentProjectName } onChange: { title.increment() }
        withObservationTracking { _ = store.deliveryNotices } onChange: { notices.increment() }
        withObservationTracking { _ = store.members } onChange: { members.increment() }

        store.state?.members[0].status = "working"
        XCTAssertEqual(members.count, 1)
        XCTAssertEqual([gate.count, reason.count, ui.count, title.count, notices.count], [0, 0, 0, 0, 0])

        store.state?.project.connection.ok = false
        XCTAssertEqual(gate.count, 0, "canWrite does not read the runner connection")
        XCTAssertEqual(ui.count, 1)
        XCTAssertEqual(reason.count, 1)
        XCTAssertEqual([title.count, notices.count], [0, 0])
        XCTAssertTrue(store.canWrite)
        XCTAssertFalse(store.uiCanWrite)
        XCTAssertEqual(store.writeBlockedReason, "프로젝트의 실행 연결을 확인해 주세요")

        let summary = UnassignedDeliverySummary(undeliveredCount: 0, unknownCount: 0, needsOwnerCount: 0)
        store.state?.deliveryNotices = DeliveryNotices(version: 1, members: [], unassigned: summary)
        XCTAssertEqual(notices.count, 0, "only version 2 notices are shown")
        XCTAssertNil(store.deliveryNotices)
        let current = DeliveryNotices(version: 2, members: [], unassigned: summary)
        store.state?.deliveryNotices = current
        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(store.deliveryNotices, current)

        let archived = SliceCounter(), named = SliceCounter()
        withObservationTracking { _ = store.canWrite } onChange: { archived.increment() }
        withObservationTracking { _ = store.currentProjectName } onChange: { named.increment() }
        store.state?.project.name = "Renamed"
        XCTAssertEqual([archived.count, named.count], [0, 1])
        XCTAssertEqual(store.currentProjectName, "Renamed")
        store.state?.project.archived = true
        XCTAssertEqual(archived.count, 1)
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(store.writeBlockedReason, "보관한 프로젝트는 읽기 전용입니다")

        store.state = nil
        XCTAssertNil(store.stateProjectID)
        XCTAssertNil(store.projectArchived)
        XCTAssertNil(store.projectConnectionOK)
        XCTAssertNil(store.deliveryNotices)
        XCTAssertEqual(store.writeBlockedReason, "프로젝트를 불러오는 중입니다")
        await network.close()
    }

    /// 판정이 `state` 전체를 읽지 않으므로, 확인이 끝나는 순간(확인한 세대가 지금 세대가 되는 때)이 그 값을 읽는 화면에 알려져야 한다.
    func testFinishingValidationReachesWriteGateReaders() async throws {
        let network = try IsolatedTestNetwork(handler: SliceServer().handle)
        let store = AppStore(session: network.session, persistCredentials: false, lowPowerMode: false)
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture"
        await store.connect()
        defer { store.disconnect() }
        XCTAssertTrue(store.canWrite)
        let validated = store.validatedProjectGeneration
        store.validatedProjectGeneration = nil
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(store.writeBlockedReason, "프로젝트를 불러오는 중입니다")
        let gate = SliceCounter(), reason = SliceCounter()
        withObservationTracking { _ = store.canWrite } onChange: { gate.increment() }
        withObservationTracking { _ = store.writeBlockedReason } onChange: { reason.increment() }
        store.validatedProjectGeneration = validated
        XCTAssertEqual([gate.count, reason.count], [1, 1])
        XCTAssertTrue(store.canWrite)
        XCTAssertNil(store.writeBlockedReason)
        let again = SliceCounter()
        withObservationTracking { _ = store.canWrite } onChange: { again.increment() }
        store.validatedProjectGeneration = validated
        store.validatedWriteGeneration = store.validatedWriteGeneration
        XCTAssertEqual(again.count, 0, "putting the same value back is not a change")
        await network.close()
    }

    /// E7 §6: 화면이 직접 받은 것을 반영하기 전의 확인은 AppStore.stillCurrent 한 곳에서 한다(전에는 화면마다 35번 손으로 썼다).
    func testStillCurrentChecksTheConnectionTheProjectAndTheArchiveView() async throws {
        let network = try IsolatedTestNetwork(handler: SliceServer().handle)
        let store = AppStore(session: network.session, persistCredentials: false, lowPowerMode: false)
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture"
        await store.connect()
        let api = try XCTUnwrap(store.api)
        XCTAssertTrue(store.stillCurrent(api))
        XCTAssertTrue(store.stillCurrent(api, project: "p"))
        XCTAssertFalse(store.stillCurrent(api, project: "q"))
        XCTAssertFalse(store.stillCurrent(api, project: nil), "a request sent with no project does not land in a project")
        XCTAssertTrue(store.stillCurrent(api, project: "p", archived: false))
        XCTAssertFalse(store.stillCurrent(api, project: "p", archived: true))
        let other = APIClient(endpoint: network.endpoint, accessCode: "fixture", session: network.session)
        XCTAssertFalse(store.stillCurrent(other), "another client to the same address is another connection")
        XCTAssertFalse(store.stillCurrent(other, project: "p"))
        XCTAssertFalse(store.stillCurrent(nil))
        store.disconnect()
        XCTAssertFalse(store.stillCurrent(api))
        XCTAssertFalse(store.stillCurrent(api, project: nil))
        XCTAssertTrue(store.stillCurrent(nil), "no connection then and now")
        XCTAssertTrue(store.stillCurrent(nil, project: nil))
        await network.close()
    }
}
