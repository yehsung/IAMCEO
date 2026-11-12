import Foundation
import XCTest
@testable import IAMCEO

/// K(E2): 도구 승인 카드(kind "tool_permission"). 서버의 요약을 읽고, 모양이 어긋나도 카드는 보통 결재로 남는다.
final class ToolPermissionCardTests: XCTestCase {
    private func decode(_ json: String) throws -> Decision {
        try JSONDecoder().decode(Decision.self, from: Data(json.utf8))
    }

    func testDecodesToolPermissionSummary() throws {
        let card = try decode(#"""
        {"id":"d1","kind":"tool_permission","who":"결제 연동","title":"명령 실행: bun test","detail":"…","status":"open",
         "options":[{"k":"allow","label":"허용","desc":"이번 한 번만 실행합니다"},{"k":"deny","label":"거절"}],
         "toolPermission":{"tool":"Bash","action":"명령 실행","target":"bun test","cwd":"/tmp/w","expiresAt":"2026-11-13T01:00:00.000Z"}}
        """#)
        XCTAssertTrue(card.isToolPermission)
        XCTAssertEqual(card.toolPermission, ToolPermission(tool: "Bash", action: "명령 실행", target: "bun test", cwd: "/tmp/w", expiresAt: "2026-11-13T01:00:00.000Z"))
        XCTAssertEqual(card.options.map(\.k), ["allow", "deny"])
        XCTAssertNil(card.rec)
    }

    func testMalformedSummaryKeepsTheCard() throws {
        // 요약의 형이 어긋나도 카드는 그대로 읽는다(선택지와 본문으로 답할 수 있다).
        let card = try decode(#"{"id":"d2","kind":"tool_permission","title":"t","options":[{"k":"allow","label":"허용"}],"toolPermission":"bad"}"#)
        XCTAssertTrue(card.isToolPermission)
        XCTAssertNil(card.toolPermission)
        XCTAssertEqual(card.options.map(\.k), ["allow"])
        // 다른 종류는 도구 승인 카드가 아니다.
        XCTAssertFalse(try decode(#"{"id":"d3","kind":"usage_limit"}"#).isToolPermission)
        XCTAssertFalse(try decode(#"{"id":"d4"}"#).isToolPermission)
    }
}
