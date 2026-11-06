import XCTest
@testable import IAMCEO

final class ContractTests: XCTestCase {
    func testDecodesOlderMemberAndUnknownEnumWithoutInventingRuntime() throws {
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"worker-1","name":"A","cli":"codex","status":"starting","contextPct":37.5}"#.utf8))
        XCTAssertEqual(member.cli, "codex")
        XCTAssertEqual(member.status, "starting")
        XCTAssertEqual(member.contextPct, 37.5)
        XCTAssertNil(member.sessionId)
        XCTAssertNil(member.backend)
    }
    func testMissingOptionalCollectionsDecodeAndMalformedTypesFail() throws {
        let state = try JSONDecoder().decode(ProjectState.self, from: Data(#"{"project":{"id":"p","name":"P"}}"#.utf8))
        XCTAssertEqual(state.project.id, "p")
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertFalse(state.project.connection.ok)
        XCTAssertThrowsError(try JSONDecoder().decode(Member.self, from: Data(#"{"subagents":"two"}"#.utf8)))
    }
    func testAnswerIncludesExactVersionAndSendKeepsID() throws {
        let answer = AnswerRequest(choice: "approve", note: nil, batch: false, expectedVersion: "2026-11-06T01:02:03.000Z")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        XCTAssertEqual(json["expectedVersion"] as? String, "2026-11-06T01:02:03.000Z")
        let request = SendMessageRequest(id: "stable-request-123", text: "Go", targetMemberId: nil, attachmentIds: [])
        let send = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(send["id"] as? String, "stable-request-123")
        XCTAssertNil(send["idempotencyKey"])
    }
    func testExplicitNullResetsMemberOverrides() throws {
        let value = PatchMemberRequest(cli: "codex", modelOverride: nil, effortOverride: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        XCTAssertTrue(json["modelOverride"] is NSNull)
        XCTAssertTrue(json["effortOverride"] is NSNull)
    }
    func testEndpointSecurityAndPathEncoding() throws {
        XCTAssertNoThrow(try ServerEndpoint("http://127.0.0.1:8787"))
        XCTAssertNoThrow(try ServerEndpoint("http://localhost:8787/"))
        // Tailscale addresses are WireGuard-encrypted and tailnet-only, so plain HTTP is allowed there.
        XCTAssertNoThrow(try ServerEndpoint("http://100.92.29.67:7878"))
        XCTAssertThrowsError(try ServerEndpoint("http://192.168.0.4:7878"))
        XCTAssertThrowsError(try ServerEndpoint("http://100.200.0.1:7878"))
        XCTAssertNoThrow(try ServerEndpoint("https://mac.tailnet.ts.net"))
        // MagicDNS names are tailnet-only and WireGuard-encrypted, like 100.x (QR pairing uses them).
        XCTAssertNoThrow(try ServerEndpoint("http://mac-mini.tail6b5aa2.ts.net:7878"))
        for invalid in ["http://ts.net", "http://example.com", "https://token@host", "https://host?token=secret", "file:///tmp", "https://host/path"] {
            XCTAssertThrowsError(try ServerEndpoint(invalid), invalid)
        }
        XCTAssertEqual(APIClient.segment("a/b?x=y&z"), "a%2Fb%3Fx%3Dy%26z")
    }
    func testForeignAttachmentCannotReceiveBearer() async throws {
        let api = APIClient(endpoint: try ServerEndpoint("https://mac.tailnet.ts.net"), accessCode: "private")
        let safe = try await api.authorizedURL("/uploads/photo.png")
        XCTAssertEqual(safe.host, "mac.tailnet.ts.net")
        do { _ = try await api.authorizedURL("https://foreign.example/file"); XCTFail("Foreign origin accepted") } catch {}
        do { _ = try await api.authorizedURL("https://mac.tailnet.ts.net:444/file"); XCTFail("Foreign port accepted") } catch {}
    }
    @MainActor func testDemoIsExplicitAndReadOnly() async {
        let store = AppStore(demo: true)
        XCTAssertTrue(store.isDemo)
        XCTAssertEqual(store.connectionStatus, .demo)
        XCTAssertFalse(store.canWrite)
        XCTAssertNil(store.api)
        let sent = await store.sendMessage(text: "Test")
        XCTAssertFalse(sent)
        XCTAssertTrue(store.errorMessage?.contains("읽기 전용") == true)
    }
    func testClearingRankDefaultsSendsExplicitNull() throws {
        let data = try JSONEncoder().encode(Settings(ranks: ["manager": RankConfig()]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let ranks = try XCTUnwrap(json["ranks"] as? [String: [String: Any]])
        XCTAssertTrue(ranks["manager"]?["model"] is NSNull)
        XCTAssertTrue(ranks["manager"]?["effort"] is NSNull)
    }

    func testDecisionReviewKeepsReviewedVersionAndRequiresExplicitReviewAfterRefresh() throws {
        let original = Decision(id: "decision", options: [DecisionOption(k: "a", label: "Original action")], updatedAt: "version-1")
        var review = DecisionReview(decision: original)
        review.choice = "a"
        review.note = "My draft note"
        XCTAssertTrue(review.canSubmit(comparedTo: original))

        var refreshed = original
        refreshed.updatedAt = "version-2"
        refreshed.options = [DecisionOption(k: "a", label: "A different action with the same key")]
        refreshed.lastNote = "Server-side note must not overwrite my draft"
        XCTAssertTrue(review.isStale(comparedTo: refreshed))
        XCTAssertFalse(review.canSubmit(comparedTo: refreshed))
        XCTAssertEqual(review.decision.updatedAt, "version-1")
        XCTAssertEqual(review.decision.options.first?.label, "Original action")

        review.reviewLatest(refreshed)
        XCTAssertFalse(review.isStale(comparedTo: refreshed))
        XCTAssertNil(review.choice)
        XCTAssertEqual(review.note, "My draft note")
        XCTAssertFalse(review.canSubmit(comparedTo: refreshed))
        review.choice = "a"
        XCTAssertTrue(review.canSubmit(comparedTo: refreshed))
        let request = AnswerRequest(choice: review.choice, note: review.note, batch: false, expectedVersion: review.decision.updatedAt)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(json["expectedVersion"] as? String, "version-2")
    }

    func testDecisionReviewBlocksMissingClosedOrInvalidChoice() {
        let original = Decision(id: "decision", options: [DecisionOption(k: "a", label: "Approve")], updatedAt: "version-1")
        var review = DecisionReview(decision: original)
        review.choice = "removed-option"
        XCTAssertFalse(review.canSubmit(comparedTo: original))
        review.choice = "a"
        XCTAssertFalse(review.canSubmit(comparedTo: nil))
        var closed = original
        closed.status = "answered"
        XCTAssertTrue(review.isStale(comparedTo: closed))
        XCTAssertFalse(review.canSubmit(comparedTo: closed))
        review.reviewLatest(closed)
        XCTAssertFalse(review.canSubmit(comparedTo: closed))
    }


    func testPairingLinkRoundTripAndRejectsForeignAddresses() throws {
        let link = PairingLink(code: "AB23CD45", urls: [URL(string: "http://100.92.29.67:7878")!])
        XCTAssertEqual(link.url.scheme, "iamceo")
        XCTAssertEqual(PairingLink(url: link.url), link)
        XCTAssertFalse(link.url.absoluteString.contains("accessCode"))
        // A QR that points somewhere outside the tailnet is ignored, so a forged code cannot send the phone elsewhere.
        XCTAssertNil(PairingLink(url: URL(string: "iamceo://pair?c=AB23CD45&u=http%3A%2F%2Fevil.example.com")!))
        XCTAssertNil(PairingLink(url: URL(string: "iamceo://pair?u=http%3A%2F%2F100.92.29.67%3A7878")!))
        XCTAssertNil(PairingLink(url: URL(string: "https://pair?c=AB23CD45&u=http%3A%2F%2F100.92.29.67%3A7878")!))
        XCTAssertTrue(Tailnet.isTailnetHost("100.64.0.1"))
        XCTAssertTrue(Tailnet.isTailnetHost("[fd7a:115c:a1e0::1]"))
        XCTAssertFalse(Tailnet.isTailnetHost("100.128.0.1"))
        XCTAssertFalse(Tailnet.isTailnetHost("10.0.0.1"))
        XCTAssertTrue(Tailnet.isTailnetHost("mac-mini.tail6b5aa2.ts.net"))
        XCTAssertFalse(Tailnet.isTailnetHost("ts.net"))
        XCTAssertFalse(Tailnet.isTailnetHost("evil-ts.net"))
    }

    @MainActor func testPairingQRRenders() throws {
        let link = PairingLink(code: "AB23CD45", urls: [URL(string: "http://mac-mini.tail6b5aa2.ts.net:7878")!])
        let image = try XCTUnwrap(QRCodeImage.render(link.url.absoluteString))
        XCTAssertGreaterThan(image.width, 200)
    }
}
