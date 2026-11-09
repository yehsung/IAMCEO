import XCTest
@testable import IAMCEO

final class ArtifactKitTests: XCTestCase {
    /// The native kit must stay the web kit: same CSS, character for character.
    func testKitMatchesSharedArtifactKit() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("shared/artifact-kit.ts"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "export const ARTIFACT_KIT_CSS = `\n"))
        let end = try XCTUnwrap(source.range(of: "\n`.trim();", range: start.upperBound..<source.endIndex))
        XCTAssertEqual(ArtifactKit.css, String(source[start.upperBound..<end.lowerBound]))
    }

    func testPolicyComesFirstAndAuthorPageAfterKit() {
        let doc = ArtifactKit.document("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body><h1>제목</h1></body></html>", title: "a<b")
        let policy = doc.range(of: "default-src 'none'")!
        let kit = doc.range(of: ":where(body)")!
        let author = doc.range(of: "default-src *")!
        XCTAssertTrue(doc.hasPrefix("<!doctype html><html lang=\"ko\"><head><meta http-equiv=\"Content-Security-Policy\""))
        XCTAssertLessThan(policy.lowerBound, kit.lowerBound)
        XCTAssertLessThan(kit.lowerBound, author.lowerBound)
        XCTAssertTrue(doc.contains("<title>a&lt;b</title>"))
    }

    func testNestedFramesAndLinksAreRenamed() {
        let doc = ArtifactKit.document("<LINK rel=preconnect href=\"https://x.test\"><iframe src=\"https://x.test\"></iframe><frameset></frameset><linked>ok</linked>\u{0}")
        XCTAssertFalse(doc.lowercased().contains("<link "))
        XCTAssertFalse(doc.contains("<iframe"))
        XCTAssertTrue(doc.contains("<x-blocked-LINK rel=preconnect"))
        XCTAssertTrue(doc.contains("</x-blocked-iframe>"))
        XCTAssertTrue(doc.contains("<x-blocked-frameset>"))
        XCTAssertTrue(doc.contains("<linked>ok</linked>"))
        XCTAssertFalse(doc.contains("\u{0}"))
    }

    func testSandboxAllowsInlineInteractionWithoutGivingAnOriginOrPopupPermission() {
        let html = ArtifactKit.sandboxDocument("</iframe><script>window.popup=window.open('https://fixture.invalid')</script><a href='#section'>목차</a><div id='section'>본문</div>", title: "자료")
        XCTAssertTrue(html.contains("sandbox=\"allow-scripts\""))
        XCTAssertFalse(html.contains("allow-same-origin"))
        XCTAssertFalse(html.contains("allow-popups"))
        XCTAssertFalse(html.contains("allow-top-navigation"))
        XCTAssertTrue(html.contains("&lt;/x-blocked-iframe&gt;"))
        XCTAssertTrue(ArtifactKit.policy.contains("script-src 'unsafe-inline'"))
        XCTAssertTrue(ArtifactKit.policy.contains("connect-src 'none'"))
        XCTAssertTrue(html.contains("RTCPeerConnection"))
    }

    func testExternalLinkConfirmationOnlyOffersBrowserURLsWithoutEmbeddedCredentials() {
        for value in ["https://example.invalid/source?q=1#section", "http://example.invalid/"] { XCTAssertNotNil(ArtifactKit.externalURL(value)) }
        for value in ["#section", "javascript:alert(1)", "file:///fixture/private", "data:text/html,a", "https://user:token@example.invalid/", "iamceo-local-file://preview?path=a", "https:///", "mailto:a@example.invalid"] {
            XCTAssertNil(ArtifactKit.externalURL(value), value)
        }
    }

}
