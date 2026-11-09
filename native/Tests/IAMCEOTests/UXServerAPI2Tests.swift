import Foundation
import XCTest
@testable import IAMCEO

final class UXServerAPI2Tests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testUnifiedNeedsAndLegacySummary() throws {
        let current = try decode(ProjectSummary.self, #"{"id":"p","needsCount":7,"needsDanger":true,"inboxCount":2,"blockedCount":1,"errorCount":1}"#)
        XCTAssertEqual(current.needsCount, 7)
        XCTAssertEqual(current.needsDanger, true)
        XCTAssertEqual(current.inboxCount, 2)
        let old = try decode(ProjectSummary.self, #"{"id":"p","inboxCount":2}"#)
        XCTAssertNil(old.needsCount)
        XCTAssertNil(old.needsDanger)
        XCTAssertEqual(old.inboxCount, 2)
    }

    func testMessageAllFilesCorrectionsContextAndDeliveryWait() throws {
        let value = try decode(Message.self, #"{"id":"m","fileId":"f1","fileIds":["f1","f2"],"supersedes":"before","supersededBy":"after","contextFileId":"context","deliveryInfo":[{"deliveryId":"d","memberId":"worker","waitReason":"run_limit","waitingSince":"2026-11-09T00:00:00Z","runLimit":{"used":4,"limit":4}}]}"#)
        XCTAssertEqual(value.fileIds, ["f1", "f2"])
        XCTAssertEqual(value.supersedes, "before")
        XCTAssertEqual(value.supersededBy, "after")
        XCTAssertEqual(value.contextFileId, "context")
        XCTAssertEqual(value.deliveryInfo?.first?.waitReason, "run_limit")
        XCTAssertEqual(value.deliveryInfo?.first?.waitingSince, "2026-11-09T00:00:00Z")
        XCTAssertEqual(value.deliveryInfo?.first?.runLimit?.used, 4)
        XCTAssertEqual(value.deliveryInfo?.first?.runLimit?.limit, 4)
        let roundTrip = try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(roundTrip.fileIds, value.fileIds)
        XCTAssertEqual(roundTrip.deliveryInfo?.first?.deliveryId, "d")
    }

    func testLegacyMessageAndUnknownWaitReasonStayCompatible() throws {
        let old = try decode(Message.self, #"{"id":"m","fileId":"f1"}"#)
        XCTAssertEqual(old.fileIds, ["f1"])
        XCTAssertNil(old.supersedes)
        XCTAssertNil(old.supersededBy)
        XCTAssertNil(old.deliveryInfo)
        XCTAssertEqual(try decode(Message.self, #"{"id":"m"}"#).fileIds, [])
        let future = try decode(Message.self, #"{"id":"m","deliveryInfo":[{"deliveryId":"d","memberId":"w","waitReason":"future_reason"}]}"#)
        XCTAssertEqual(future.deliveryInfo?.first?.waitReason, "future_reason")
        XCTAssertNil(future.deliveryInfo?.first?.runLimit)
    }

    func testDeliveryItemSummaryAndReportNotices() throws {
        let item = try decode(DeliveryNoticeItem.self, #"{"id":"d","waitReason":"waking","waitingSince":"start","runLimit":{"used":2,"limit":3}}"#)
        XCTAssertEqual(item.waitReason, "waking")
        XCTAssertEqual(item.waitingSince, "start")
        XCTAssertEqual(item.runLimit?.limit, 3)
        XCTAssertNil(try decode(DeliveryNoticeItem.self, #"{"id":"old"}"#).waitReason)
        let json = #"{"version":2,"members":[{"memberId":"w","undeliveredCount":1,"unknownCount":0,"deliveringCount":0,"checkingCount":0,"needsOwnerCount":1,"waitingBehindCount":0,"oldestAt":null,"reasons":[],"waitReason":"run_limit","waitingSince":"start","runLimit":{"used":4,"limit":4},"waitReasons":[{"waitReason":"run_limit","waitingSince":"start","runLimit":{"used":4,"limit":4},"count":2}]}],"unassigned":{"undeliveredCount":0,"unknownCount":0,"needsOwnerCount":0},"reportNotices":[{"kind":"missing_report","runId":"r","memberId":"w","messageId":"m","createdAt":"start","title":"결과 보고 누락"}]}"#
        let notices = try decode(DeliveryNotices.self, json)
        XCTAssertEqual(notices.members.first?.waitReason, "run_limit")
        XCTAssertEqual(notices.members.first?.waitingSince, "start")
        XCTAssertEqual(notices.members.first?.runLimit?.used, 4)
        XCTAssertEqual(notices.members.first?.waitReasons?.first?.count, 2)
        XCTAssertEqual(notices.reportNotices?.first?.runId, "r")
        XCTAssertEqual(notices.reportNotices?.first?.messageId, "m")
        let legacy = try decode(DeliveryNotices.self, #"{"version":2,"members":[{"memberId":"w","undeliveredCount":0,"unknownCount":0,"deliveringCount":0,"checkingCount":0,"needsOwnerCount":0,"waitingBehindCount":0,"oldestAt":null,"reasons":[]}],"unassigned":{"undeliveredCount":0,"unknownCount":0,"needsOwnerCount":0}}"#)
        XCTAssertNil(legacy.members.first?.waitReason)
        XCTAssertNil(legacy.members.first?.waitReasons)
        XCTAssertNil(legacy.reportNotices)
    }

    func testLiteFileAndNewCompletionSettingsDecodeWithOldDefaults() throws {
        let lite = try decode(FileDoc.self, #"{"id":"f","title":"자료","reused":true}"#)
        XCTAssertEqual(lite.body, "")
        XCTAssertEqual(lite.reused, true)
        let todo = try decode(Todo.self, #"{"id":"t","done":true,"completionNote":"  답\n원문  ","completionFileIds":["a","b"]}"#)
        XCTAssertEqual(todo.completionNote, "  답\n원문  ")
        XCTAssertEqual(todo.completionFileIds, ["a", "b"])
        XCTAssertEqual(try decode(Todo.self, #"{"id":"old"}"#).completionFileIds, [])
        XCTAssertTrue(try decode(Settings.self, "{}").macScriptNotifications)
        XCTAssertFalse(try decode(Settings.self, #"{"macScriptNotifications":false}"#).macScriptNotifications)
    }

    func testRequestAdditionsAreOptionalAndPreserveOriginal() throws {
        let original = SendMessageRequest(id: "m", text: "대표 원문", targetMemberId: nil, attachmentIds: [])
        var request = original
        request.contextFileId = "file"
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(encoded["text"] as? String, "대표 원문")
        XCTAssertEqual(encoded["contextFileId"] as? String, "file")
        let old = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        XCTAssertNil(old["contextFileId"])
        let completion = TodoCompletionRequest(done: true, note: "  원문\n답  ", fileIds: ["a", "b"])
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(completion)) as? [String: Any])
        XCTAssertEqual(body["note"] as? String, "  원문\n답  ")
        XCTAssertEqual(body["fileIds"] as? [String], ["a", "b"])
    }

    func testFileCacheIsBoundToAPIInstanceAndLiteIsOptIn() async throws {
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/files/f" { return IsolatedTestHTTPReply(data: Data(#"{"id":"f","projectId":"p","body":"full body"}"#.utf8)) }
            if request.url?.path == "/api/projects/p/state" { return IsolatedTestHTTPReply(data: Data(#"{"project":{"id":"p"}}"#.utf8)) }
            throw URLError(.unsupportedURL)
        }
        addTeardownBlock { await network.close() }
        let client = APIClient(endpoint: network.endpoint, accessCode: "fixture", session: network.session)
        let first = try await client.fileBody(id: "f")
        let cached = try await client.fileBody(id: "f")
        XCTAssertEqual(first.body, "full body")
        XCTAssertEqual(cached.body, first.body)
        XCTAssertEqual(network.requests.count, 1)
        _ = try await client.fileBody(id: "f", forceRefresh: true)
        XCTAssertEqual(network.requests.count, 2)
        let _: ProjectState = try await client.request("/api/projects/p/state")
        XCTAssertNil(network.requests.last?.url?.query)
        let lite = APIClient(endpoint: network.endpoint, accessCode: "another-fixture", session: network.session, liteStateEnabled: true)
        let _: ProjectState = try await lite.request("/api/projects/p/state")
        XCTAssertEqual(network.requests.last?.url?.query, "lite=1")
        _ = try await lite.fileBody(id: "f")
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/files/f" }.count, 3)
        let ws = try await lite.webSocketRequest()
        XCTAssertTrue(ws.url?.query?.contains("lite=1") == true)
    }

    func testDecodingFailureKeepsCompatibilityMessageWithoutRawDetails() async throws {
        let network = try IsolatedTestNetwork { request in
            let json = request.url?.path == "/malformed" ? "not json: private fixture detail" : #"{"id":{"privateFixtureDetail":true}}"#
            return IsolatedTestHTTPReply(data: Data(json.utf8))
        }
        addTeardownBlock { await network.close() }
        let client = network.makeAPIClient()
        for path in ["/malformed", "/wrong-type"] {
            do {
                let _: Message = try await client.request(path)
                XCTFail("Invalid response decoded successfully")
            } catch let error as APIError {
                XCTAssertEqual(error.status, 0)
                XCTAssertTrue(error.message.contains("호환되지 않습니다"))
                XCTAssertEqual(error.message, "서버 응답이 이 앱과 호환되지 않습니다. 앱과 서버 버전을 확인해 주세요.")
            }
        }
        XCTAssertEqual(network.requests.count, 2)
    }
}
