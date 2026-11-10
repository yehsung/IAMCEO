import Foundation
import XCTest
@testable import IAMCEO

/// 부가 정보 하나가 어긋나도 동기화 전체가 실패하지 않아야 한다(서버만 먼저 바뀌는 평소 흐름).
final class StabnsvcLenientDecodeTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testMalformedMemberDecorationsBecomeAbsentWithoutLosingTheMember() throws {
        // runId·operationId 누락, 토큰 수가 소수, 형이 다른 관찰 정보.
        let member = try decode(Member.self, #"""
        {"id":"m","name":"A","status":"working","subagents":2,
         "executionState":{"phase":"running"},
         "lifecycleState":{"phase":"starting"},
         "statusObservation":"fresh",
         "subagentState":{"count":"many"},
         "contextState":{"measurement":{"tokens":1234.5},"compaction":{"id":"c","phase":"running"}}}
        """#)
        XCTAssertEqual(member.id, "m")
        XCTAssertEqual(member.status, "working")
        XCTAssertEqual(member.subagents, 2)
        XCTAssertNil(member.executionState)
        XCTAssertNil(member.lifecycleState)
        XCTAssertNil(member.statusObservation)
        XCTAssertNil(member.subagentState)
        // 한쪽만 어긋나면 그쪽만 비운다.
        XCTAssertNil(member.contextState?.measurement)
        XCTAssertEqual(member.contextState?.compaction?.id, "c")
        // 핵심 값의 형 불일치는 여전히 실패한다.
        XCTAssertThrowsError(try decode(Member.self, #"{"id":"m","subagents":"two"}"#))
    }

    func testSnapshotSurvivesMalformedDecorationsAndDropsOnlyUnreadableRows() throws {
        let snapshot = try decode(SyncSnapshot.self, #"""
        {"protocol":2,"cursor":{"epoch":"e","seq":4},"requestedProjectId":"p","projectStatus":"ok",
         "apiOutage":{"since":null},
         "bootstrap":{"apiOutage":{"affectedMemberIds":"all"},"runtime":"core",
                      "projects":[{"id":"p","name":"P"},{"name":"id 없음"},{"id":"q","decisionCount":"3"}]},
         "state":{"project":{"id":"p"},
                  "members":[{"id":"a"},{"id":"b","subagents":"two"},{"id":"c","executionState":{}}],
                  "decisions":[{"id":"d","usageLimit":[],"options":[{"k":"1","label":"가"},7],"images":[{"id":"i"},{"name":"id 없음"}]},{"title":"id 없음"}],
                  "todos":[{"id":"t"},{"id":7}],
                  "work":[{"id":"w"},{"id":"x","order":"first"}],
                  "messages":[{"id":"msg","deliveryInfo":[{"deliveryId":"dv","memberId":"a"},{"deliveryId":"missing member"}],"attachments":[{"id":"f","size":1},{"size":2}]},
                              {"id":"msg2","deliveryInfo":"none"},{"body":"id 없음"}],
                  "files":[{"id":"file"},{"id":"bad","order":"x"}],
                  "deliveryNotices":{"version":2,"members":"none","unassigned":{}}}}
        """#)
        XCTAssertNil(snapshot.apiOutage)
        XCTAssertNil(snapshot.bootstrap.apiOutage)
        XCTAssertNil(snapshot.bootstrap.runtime)
        XCTAssertEqual(snapshot.bootstrap.projects.map(\.id), ["p"])
        let state = try XCTUnwrap(snapshot.state)
        XCTAssertEqual(state.members.map(\.id), ["a", "c"])
        XCTAssertNil(state.members.last?.executionState)
        XCTAssertEqual(state.decisions.map(\.id), ["d"])
        XCTAssertNil(state.decisions.first?.usageLimit)
        XCTAssertEqual(state.decisions.first?.options.map(\.k), ["1"])
        XCTAssertEqual(state.decisions.first?.images.map(\.id), ["i"])
        XCTAssertEqual(state.todos.map(\.id), ["t"])
        XCTAssertEqual(state.work.map(\.id), ["w"])
        XCTAssertEqual(state.messages.map(\.id), ["msg", "msg2"])
        XCTAssertEqual(state.messages.first?.deliveryInfo?.map(\.deliveryId), ["dv"])
        XCTAssertEqual(state.messages.first?.attachments.map(\.id), ["f"])
        XCTAssertNil(state.messages.last?.deliveryInfo)
        XCTAssertEqual(state.files.map(\.id), ["file"])
        XCTAssertNil(state.deliveryNotices)
    }

    func testDeliveryNoticesKeepReadableRowsAndTolerateMissingNote() throws {
        let state = try decode(ProjectState.self, #"""
        {"project":{"id":"p"},"deliveryNotices":{"version":2,
          "members":[
            {"memberId":"a","undeliveredCount":1,"unknownCount":0,"deliveringCount":0,"checkingCount":0,"needsOwnerCount":1,"waitingBehindCount":0,"oldestAt":null,
             "reasons":[{"code":"blocked","count":1}]},
            {"memberId":"b","undeliveredCount":null}],
          "unassigned":{"undeliveredCount":0,"unknownCount":0,"needsOwnerCount":2},
          "reportNotices":[{"kind":"missing_report","runId":"r","memberId":"a","messageId":"m","createdAt":"t","title":"누락"},{"kind":"missing_report"}],
          "unassignedItems":[{"id":"u","messageId":"m","projectId":"p","memberId":"","version":1,"preview":"","createdAt":"t","allowedActions":["dismiss","future"]},
                             {"id":"no version"}]}}
        """#)
        let notices = try XCTUnwrap(state.deliveryNotices)
        XCTAssertEqual(notices.members.map(\.memberId), ["a"])
        XCTAssertEqual(notices.members.first?.reasons.first?.note, "")
        XCTAssertEqual(notices.unassigned.needsOwnerCount, 2)
        XCTAssertEqual(notices.reportNotices?.map(\.runId), ["r"])
        XCTAssertEqual(notices.unassignedItems?.map(\.id), ["u"])
        XCTAssertEqual(notices.unassignedItems?.first?.allowedActions, [.dismiss, .unknown])
    }

    func testStrictContractsStayStrict() throws {
        // 목록이 없는 bootstrap 을 빈 회사로 읽지 않는다.
        XCTAssertThrowsError(try decode(Bootstrap.self, #"{"version":"1"}"#))
        XCTAssertThrowsError(try decode(Bootstrap.self, #"{"projects":null}"#))
        // 배열 자리에 다른 형이 오면 실패한다(원소 단위로만 관대하다).
        XCTAssertThrowsError(try decode(ProjectState.self, #"{"project":{"id":"p"},"members":{"id":"m"}}"#))
        XCTAssertThrowsError(try decode(ProjectState.self, #"{"members":[]}"#))
        // 대화 페이지는 잘린 페이지를 끝으로 오인하지 않도록 엄격하게 둔다.
        XCTAssertThrowsError(try decode(MessagePage.self, #"{"projectId":"p","scope":{"kind":"project"},"items":[{"body":"id 없음"}],"hasOlder":false}"#))
    }

    func testRealtimeFramesSurviveMalformedDecorationsAndRows() throws {
        let member = try decode(RealtimeEvent.self, #"{"type":"member","epoch":"e","seq":3,"member":{"id":"m","projectId":"p","lifecycleState":{},"executionState":{"runId":7}}}"#)
        XCTAssertEqual(member.member?.id, "m")
        XCTAssertNil(member.member?.lifecycleState)
        XCTAssertNil(member.member?.executionState)
        let message = try decode(RealtimeEvent.self, #"{"type":"message","epoch":"e","seq":4,"message":{"id":"msg","deliveryInfo":[{"memberId":"m"}]}}"#)
        XCTAssertEqual(message.message?.deliveryInfo, [])
        let projects = try decode(RealtimeEvent.self, #"{"type":"projects","epoch":"e","seq":5,"projects":[{"id":"p"},{"needsCount":1}]}"#)
        XCTAssertEqual(projects.projects?.map(\.id), ["p"])
        let work = try decode(RealtimeEvent.self, #"{"type":"work","epoch":"e","seq":6,"projectId":"p","work":[{"id":"w"},{}]}"#)
        XCTAssertEqual(work.work?.map(\.id), ["w"])
        // 필수 본문이 아예 없는 프레임은 여전히 잘못된 프레임이다.
        XCTAssertThrowsError(try decode(RealtimeEvent.self, #"{"type":"projects","epoch":"e","seq":7}"#))
        XCTAssertThrowsError(try decode(RealtimeEvent.self, #"{"type":"work","epoch":"e","seq":8,"projectId":"p"}"#))
        XCTAssertThrowsError(try decode(RealtimeEvent.self, #"{"type":"member","epoch":"e","seq":9,"member":{"projectId":"p"}}"#))
    }
}
