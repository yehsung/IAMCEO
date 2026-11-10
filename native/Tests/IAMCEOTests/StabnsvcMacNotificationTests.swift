import Foundation
import XCTest
@testable import IAMCEO

/// 끊긴 동안 생긴 항목은 다시 연결한 뒤 알리고, 기준을 읽지 못한 프로젝트는 이미 있던 것을 새것으로 알리지 않는다.
final class StabnsvcMacNotificationTests: XCTestCase {
    private func event<T: Encodable>(_ type: String, _ value: T) throws -> RealtimeEvent {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        return try JSONDecoder().decode(RealtimeEvent.self, from: JSONSerialization.data(withJSONObject: ["type": type, type: object]))
    }
    private func state(decisions: [Decision] = [], members: [Member] = [], todos: [Todo] = [], messages: [Message] = []) -> ProjectState {
        ProjectState(project: Project(id: "p"), members: members, decisions: decisions, todos: todos, messages: messages)
    }

    func testReconcileReportsOnlyWhatAppearedWhileDisconnected() throws {
        var tracker = MacNotificationTracker()
        let oldDecision = Decision(id: "d1", projectId: "p", status: "open")
        let answered = Decision(id: "d2", projectId: "p", status: "answered")
        let idle = Member(id: "m", projectId: "p", status: "idle")
        let oldReport = Message(id: "r1", projectId: "p", at: "2026-11-10T01:00:00.000Z", memberId: "m", kind: "완료")
        tracker.seed(state(decisions: [oldDecision, answered], members: [idle], todos: [Todo(id: "t1", projectId: "p")], messages: [oldReport]))

        // 그대로면 조용하다.
        XCTAssertEqual(tracker.reconcile(state(decisions: [oldDecision, answered], members: [idle], todos: [Todo(id: "t1", projectId: "p")], messages: [oldReport])), [])

        let waiting = Member(id: "m", projectId: "p", status: "blocked", blockedReason: "permission")
        let found = tracker.reconcile(state(
            decisions: [oldDecision, Decision(id: "d2", projectId: "p", status: "open"), Decision(id: "d3", projectId: "p", status: "open"), Decision(id: "d4", projectId: "p", status: "answered")],
            members: [waiting],
            todos: [Todo(id: "t1", projectId: "p"), Todo(id: "t2", projectId: "p"), Todo(id: "t3", projectId: "p", done: true)],
            messages: [oldReport,
                       Message(id: "r2", projectId: "p", at: "2026-11-10T02:00:00.000Z", memberId: "m", kind: "막힘"),
                       Message(id: "mine", projectId: "p", at: "2026-11-10T02:01:00.000Z", mine: true, kind: "완료"),
                       Message(id: "progress", projectId: "p", at: "2026-11-10T02:02:00.000Z", kind: "진행"),
                       // 기억 상한 밖으로 밀려났던 옛 보고가 다시 보여도 알리지 않는다.
                       Message(id: "ancient", projectId: "p", at: "2026-11-09T00:00:00.000Z", memberId: "m", kind: "완료")]))
        XCTAssertEqual(found.map(\.kind), ["decision", "decision", "approval_wait", "todo_created", "report_blocked"])
        XCTAssertEqual(found.map(\.sourceID), ["d2", "d3", "m", "t2", "r2"])
        XCTAssertEqual(found.first?.target, .inbox(projectId: "p", decisionId: "d2"))
        // 같은 것을 두 번 알리지 않는다: 다시 읽어도, 뒤늦은 이벤트가 와도.
        XCTAssertEqual(tracker.reconcile(state(decisions: [Decision(id: "d3", projectId: "p", status: "open")], members: [waiting])), [])
        XCTAssertNil(try tracker.event(event("decision", Decision(id: "d3", projectId: "p", status: "open"))))
        XCTAssertNil(try tracker.event(event("member", waiting)))
        XCTAssertNil(try tracker.event(event("message", Message(id: "r2", projectId: "p", memberId: "m", kind: "막힘"))))
    }

    func testHeldProjectStaysQuietUntilItsBaselineIsRead() throws {
        var tracker = MacNotificationTracker()
        tracker.hold(projectID: "p")
        XCTAssertTrue(tracker.isHeld("p"))
        // 기준을 모르는 동안에는 이미 있던 결재의 갱신을 새 결재로 알리지 않는다.
        XCTAssertNil(try tracker.event(event("decision", Decision(id: "d1", projectId: "p", status: "open"))))
        XCTAssertNil(try tracker.event(event("message", Message(id: "r1", projectId: "p", memberId: "m", kind: "완료"))))
        // 다른 프로젝트는 그대로 알린다.
        XCTAssertEqual(try tracker.event(event("decision", Decision(id: "d1", projectId: "q", status: "open")))?.kind, "decision")
        // 처음 읽은 상태는 기준만 잡는다.
        XCTAssertEqual(tracker.reconcile(state(decisions: [Decision(id: "d1", projectId: "p", status: "open"), Decision(id: "d2", projectId: "p", status: "open")])), [])
        XCTAssertFalse(tracker.isHeld("p"))
        // 그 뒤로는 새 항목을 알린다.
        XCTAssertNil(try tracker.event(event("decision", Decision(id: "d2", projectId: "p", status: "open"))))
        XCTAssertEqual(try tracker.event(event("decision", Decision(id: "d3", projectId: "p", status: "open")))?.sourceID, "d3")
    }

    func testReconnectDelayBacksOffToOneMinute() {
        XCTAssertEqual((0...8).map { MacNotificationPolicy.reconnectDelay(failures: $0) },
                       [3, 3, 6, 12, 24, 48, 60, 60, 60].map { Duration.seconds($0) })
        XCTAssertEqual(MacNotificationPolicy.reconnectDelay(failures: .max), .seconds(60))
    }
}
