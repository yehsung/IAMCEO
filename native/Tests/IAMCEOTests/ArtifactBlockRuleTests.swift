import Foundation
import WebKit
import XCTest
@testable import IAMCEO

final class ArtifactBlockRuleTests: XCTestCase {
    func testOnlyInitialBlankMainFrameHTMLLoadMayNavigate() {
        XCTAssertTrue(artifactAllowsNavigation(firstAction: true, url: URL(string: "about:blank"), mainFrame: true, type: .other))
        let types: [WKNavigationType] = [.linkActivated, .formSubmitted, .backForward, .reload, .formResubmitted, .other]
        let urls = ["about:blank", "about:blank#fragment", "https://fixture.invalid/", "file:///fixture/a",
                    "ssh://fixture.invalid/", "custom-app:argument", "data:text/html,hello", "blob:fixture"]
        for first in [true, false] {
            for main in [true, false] {
                for type in types {
                    for url in urls {
                        XCTAssertEqual(artifactAllowsNavigation(firstAction: first, url: URL(string: url), mainFrame: main, type: type),
                            first && main && type == .other && url == "about:blank", "\(first) \(main) \(type) \(url)")
                    }
                }
            }
        }
        XCTAssertFalse(artifactAllowsNavigation(firstAction: true, url: nil, mainFrame: true, type: .other))
    }

    private func rules() throws -> [[String: [String: String]]] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(artifactBlockRuleJSON().utf8)) as? [[String: [String: String]]])
    }

    func testSeparateBlockRulesHaveNoDisjunctionOrResourceExceptions() throws {
        XCTAssertFalse(artifactBlockRuleJSON().contains("|"))
        let rules = try rules()
        XCTAssertEqual(rules.count, 4)
        XCTAssertEqual(rules.compactMap { $0["trigger"]?["url-filter"] }, ["^https?:", "^wss?:", "^file:", "^ftps?:"])
        for rule in rules {
            XCTAssertEqual(Set(rule.keys), ["trigger", "action"])
            XCTAssertEqual(rule["trigger"]?.count, 1)
            XCTAssertEqual(rule["action"], ["type": "block"])
        }
    }

    func testExternalAndFileSchemesMatchWhileInlineDataAndBlankDocumentDoNot() throws {
        let filters = try rules().map { rule in
            try NSRegularExpression(pattern: XCTUnwrap(rule["trigger"]?["url-filter"]), options: .caseInsensitive)
        }
        func blocked(_ url: String) -> Bool {
            filters.contains { $0.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil }
        }
        // Match strings only: none of these URLs is opened or requested.
        for url in ["http://fixture.invalid/a", "https://fixture.invalid/a", "ws://fixture.invalid/a",
                    "wss://fixture.invalid/a", "file:///fixture/a", "ftp://fixture.invalid/a", "ftps://fixture.invalid/a",
                    "HTTPS://fixture.invalid/a", "WSS://fixture.invalid/a", "FILE:///fixture/a", "FTP://fixture.invalid/a"] {
            XCTAssertTrue(blocked(url), url)
        }
        for url in ["data:image/png;base64,AA==", "data:font/woff2;base64,AA==", "about:blank"] {
            XCTAssertFalse(blocked(url), url)
        }
    }

    @MainActor func testWebKitCompilesGeneratedRulesInIsolatedStore() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-artifact-rules-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try XCTUnwrap(WKContentRuleListStore(url: directory))
        let compiled = expectation(description: "WebKit compiles artifact block rules")
        store.compileContentRuleList(forIdentifier: "IAMCEOArtifactRuleTest", encodedContentRuleList: artifactBlockRuleJSON()) { rule, error in
            XCTAssertNil(error, "WebKit compilation failed: \(String(describing: error))")
            XCTAssertNotNil(rule)
            compiled.fulfill()
        }
        await fulfillment(of: [compiled], timeout: 15)
    }
}
