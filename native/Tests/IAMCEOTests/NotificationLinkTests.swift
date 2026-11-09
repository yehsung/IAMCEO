import Foundation
import XCTest
@testable import IAMCEO

final class NotificationLinkTests: XCTestCase {
    private let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
    private let event = "32c3c71b-2e9b-4f02-9edc-d23d372d418f"
    private func metadata(kind: String = "decision", target: String = #"{"screen":"inbox","projectId":"hq","decisionId":"d_1"}"#) -> Data {
        Data("{\"v\":1,\"serverId\":\"\(server)\",\"eventId\":\"\(event)\",\"kind\":\"\(kind)\",\"target\":\(target)}".utf8)
    }

    func testLinksHaveFixedGrammarAndDecodeExactlyOnce() throws {
        let prefix = "iamceo://open/\(server)/projects/hq/"
        let decision = try XCTUnwrap(NotificationLink(url: XCTUnwrap(URL(string: prefix + "decisions/d_1"))))
        XCTAssertEqual(decision.target, .inbox(projectId: "hq", decisionId: "d_1"))
        XCTAssertNil(decision.eventID)
        XCTAssertEqual(NotificationLink.parse(url: try XCTUnwrap(URL(string: prefix + "members/m_1")))?.target, .team(projectId: "hq", memberId: "m_1"))
        XCTAssertEqual(NotificationLink.parse(url: try XCTUnwrap(URL(string: prefix + "chat/msg_1")))?.target, .chat(projectId: "hq", memberId: nil, messageId: "msg_1"))
        XCTAssertNotNil(NotificationLink.parse(url: try XCTUnwrap(URL(string: prefix + "chat/%6Dsg_1"))))
        let invalid = [
            prefix + "chat/%256Dsg_1", prefix + "chat/a%2Fb", prefix + "chat/a%5Cb", prefix + "chat/a%00b",
            prefix + "chat/a?token=secret", prefix + "chat/a?", prefix + "chat/a#fragment", prefix + "chat/a#",
            prefix + "chat/a/", prefix + "chat/..", prefix + "chat/" + String(repeating: "a", count: 201),
            prefix + "files/f_1", prefix.replacingOccurrences(of: "iamceo:", with: "https:") + "chat/a",
            "iamceo://user:password@open/\(server)/projects/hq/chat/a",
            "iamceo://open:123/\(server)/projects/hq/chat/a", "iamceo://open/not-uuid/projects/hq/chat/a",
            "iamceo://pair?c=123&u=https://host.example", "iamceo://open/\(server)//projects/hq/chat/a"
        ]
        for text in invalid { XCTAssertNil(NotificationLink.parse(url: try XCTUnwrap(URL(string: text))), text) }
    }

    func testPayloadStrictVersionKindTargetAndNoCredentials() throws {
        let valid = try XCTUnwrap(NotificationLink.parse(metadata: metadata()))
        XCTAssertEqual(valid.serverID, server); XCTAssertEqual(valid.eventID, event)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: metadata()) as? [String: Any])
        XCTAssertEqual(NotificationLink.parse(payload: ["aps": ["alert": "fixed"], "iamceo": json]), valid)
        for data in [
            Data(String(decoding: metadata(), as: UTF8.self).replacingOccurrences(of: "\"v\":1", with: "\"v\":true").utf8),
            Data(String(decoding: metadata(), as: UTF8.self).replacingOccurrences(of: "\"v\":1", with: "\"v\":2").utf8),
            Data(String(decoding: metadata(), as: UTF8.self).replacingOccurrences(of: server, with: "https://evil.invalid").utf8),
            metadata(kind: "unknown"), metadata(kind: "question"), metadata(kind: "error"),
            metadata(target: #"{"screen":"inbox","projectId":"hq","decisionId":"d_1","url":"https://evil.invalid"}"#),
            metadata(target: #"{"screen":"inbox","projectId":"hq","decisionId":"../d_1"}"#),
            metadata(target: #"{"screen":"future"}"#), Data(repeating: 32, count: 8193)
        ] { XCTAssertNil(NotificationLink.parse(metadata: data)) }
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(kind: "test", target: #"{"screen":"home"}"#)))
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(kind: "approval_wait", target: #"{"screen":"team","projectId":"p_1","memberId":"m_1"}"#)))
        XCTAssertNotNil(NotificationLink.parse(metadata: metadata(kind: "report_complete", target: #"{"screen":"chat","projectId":"hq","memberId":null,"messageId":"old_report","groupId":"277551bf-cf60-4ecd-a450-1fd3e695a8d8"}"#)))
    }


    func testTodoAndBlockedKindTargetAllowlistAndHomeRoundTrip() throws {
        let target = PushTarget.projectHome(projectId: "p_1")
        XCTAssertEqual(NotificationLink.parse(metadata: metadata(kind: "todo_created", target: #"{"screen":"home","projectId":"p_1"}"#))?.target, target)
        XCTAssertEqual(try JSONDecoder().decode(PushTarget.self, from: JSONEncoder().encode(target)), target)
        XCTAssertEqual(NotificationLink.parse(metadata: metadata(kind: "report_blocked", target: #"{"screen":"chat","projectId":"p_1","memberId":"m","messageId":"blocked"}"#))?.target,
            .chat(projectId: "p_1", memberId: "m", messageId: "blocked"))
        for (kind, target) in [
            ("todo_created", #"{"screen":"home"}"#),
            ("todo_created", #"{"screen":"home","projectId":null}"#),
            ("todo_created", #"{"screen":"home","projectId":"../p"}"#),
            ("todo_created", #"{"screen":"home","projectId":"p","action":"done"}"#),
            ("todo_created", #"{"screen":"chat","projectId":"p","messageId":"m"}"#),
            ("report_blocked", #"{"screen":"home","projectId":"p"}"#),
            ("test", #"{"screen":"home","projectId":"p"}"#)
        ] { XCTAssertNil(NotificationLink.parse(metadata: metadata(kind: kind, target: target))) }
    }

    @MainActor func testColdTapMailboxDeduplicatesAcrossWindowsAndForegroundOnlyRefreshes() throws {
        let inbox = NotificationInbox()
        let link = try XCTUnwrap(NotificationLink.parse(metadata: metadata()))
        inbox.receive(link, tapped: false)
        XCTAssertTrue(inbox.pending.isEmpty); XCTAssertEqual(inbox.refreshRevision, 1)
        inbox.receive(link, tapped: true); inbox.receive(link, tapped: true)
        XCTAssertEqual(inbox.pending.count, 1)
        XCTAssertNil(inbox.consume(serverID: UUID().uuidString))
        XCTAssertEqual(inbox.consume(serverID: server), link)
        XCTAssertNil(inbox.consume(serverID: server))
        inbox.receive(link, tapped: true)
        XCTAssertTrue(inbox.pending.isEmpty)
    }
}
