import Foundation
import XCTest
@testable import IAMCEO

final class LocalFileTests: XCTestCase {
    func testPathDetectionAcceptsConcreteFilesAndRejectsProseURLsAndEmails() {
        for value in ["/Users/test/video/ad.md", "~/Downloads/영상.mp4", "docs/spec.md", "src/views", "./script", "../notes.txt", "장면표_초안_1107.md", "~/folder with spaces/a.md", "/Users/test/assets/logo@2x.png", "~/Downloads/report@2026.md", "./assets/logo@2x.png"] {
            XCTAssertTrue(LocalFileLinks.isPath(value), value)
        }
        for value in ["https://example.com/a.md", "http://localhost/a/b", "www.example.com/a.md", "user@example.com", "me@host/a.md", "mailto:person@example.com", "and/or", "입력/출력", "및/또는", "CI/CD", "2026/11/08", "/", "~/", "일반 문장", "//example.com/a.md"] {
            XCTAssertFalse(LocalFileLinks.isPath(value), value)
        }
    }
    func testMarkdownLinksInlineCodePlainTextAndPreservesExistingWebLinks() throws {
        let result = markdownInline("복사: `장면표_초안_1107.md`, ~/Downloads/a.mp4. docs/spec.md https://example.com/a.md person@example.com [웹](https://example.com/path.md)")
        let paths = result.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }
        XCTAssertEqual(paths, ["장면표_초안_1107.md", "~/Downloads/a.mp4", "docs/spec.md"])
        XCTAssertTrue(result.runs.contains { $0.link?.scheme == "https" })
        let namedWeb = markdownInline("[~/Downloads/report@2026.md](https://example.com)")
        XCTAssertEqual(namedWeb.runs.compactMap { $0.link?.absoluteString }, ["https://example.com"])
        let spaces = markdownInline("`~/folder with spaces/a.md`")
        XCTAssertEqual(spaces.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, ["~/folder with spaces/a.md"])
        let particle = markdownInline("`장면표_초안_1107.md`의 블록")
        XCTAssertEqual(particle.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, ["장면표_초안_1107.md"])
        for text in ["https://host/a.md?next=/tmp/a.md", "name@host/docs/a.md", "https://host/a.md;other=/tmp/b.md"] {
            XCTAssertTrue(markdownInline(text).runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }.isEmpty, text)
        }
    }
    func testCodeBoundariesLeaveParticlesUnlinkedAndExcludeWholeURLs() {
        for path in ["~/project/a.md", "/Users/test/a.md", "B2_장면표.md"] {
            for particle in ["의", "를", "에서"] {
                let result = markdownInline("`\(path)`\(particle) 블록")
                XCTAssertEqual(String(result.characters), "\(path)\(particle) 블록")
                for run in result.runs {
                    let text = String(result[run.range].characters)
                    if let url = run.link {
                        XCTAssertEqual(LocalFileLinks.path(url), path)
                        XCTAssertEqual(text, path)
                        XCTAssertTrue(run.inlinePresentationIntent?.contains(.code) == true)
                        XCTAssertNotNil(run.underlineStyle)
                        XCTAssertNotNil(run.foregroundColor)
                    } else if text.contains(particle) {
                        XCTAssertNil(run.link)
                    }
                }
                XCTAssertEqual(result.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, [path])
            }
        }
        for url in ["https://example.com/(docs/a.md)", "https://host/a.md?next=/tmp/a.md", "www.host.test/(docs/a.md)", "WWW.host.test/(docs/a.md)"] {
            for source in [url, "`\(url)`"] {
                let result = markdownInline(source)
                XCTAssertEqual(String(result.characters), url)
                XCTAssertTrue(result.runs.allSatisfy { $0.link.flatMap(LocalFileLinks.path) == nil }, source)
            }
        }
    }
    func testAtSignsInExplicitPathsLinkInCodeAndProse() {
        for path in ["/Users/test/assets/logo@2x.png", "~/Downloads/report@2026.md", "./assets/logo@2x.png"] {
            for source in [path, "`\(path)`"] {
                let result = markdownInline(source)
                XCTAssertEqual(String(result.characters), path)
                XCTAssertEqual(result.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, [path])
            }
        }
    }
    func testAuthoredMailtoLinksKeepTheirAddressAndAttributes() {
        for label in ["docs/spec.md", "~/Downloads/report@2026.md"] {
            let result = markdownInline("[\(label)](mailto:review@example.com)")
            XCTAssertEqual(String(result.characters), label)
            XCTAssertEqual(result.runs.compactMap { $0.link?.absoluteString }, ["mailto:review@example.com"])
            XCTAssertTrue(result.runs.allSatisfy { $0.link.flatMap(LocalFileLinks.path) == nil })
        }
        // Exercise the detector correction independently of OS parser versions.
        let path = "./assets/logo@2x.png"
        var detected = AttributedString(path)
        detected.link = URL(string: "mailto:\(path)")
        let corrected = LocalFileLinks.applying(to: detected)
        XCTAssertEqual(corrected.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, [path])
        XCTAssertTrue(corrected.runs.allSatisfy { $0.underlineStyle != nil && $0.foregroundColor != nil })
        detected.link = URL(string: "mailto:review@example.com")
        XCTAssertEqual(LocalFileLinks.applying(to: detected).runs.compactMap { $0.link?.absoluteString }, ["mailto:review@example.com"])
    }
    func testParsedTableCellsPreserveHomePathsSingleTildesStrikethroughAndWebLinks() throws {
        let source = "| 파일 | 설명 |\n| --- | --- |\n| `~/docs/a.md` | ~ ~~취소선~~ [웹](https://example.com/path.md) |"
        let blocks = MarkdownBlock.parse(source)
        XCTAssertEqual(blocks.count, 1)
        guard case .table(let table) = try XCTUnwrap(blocks.first) else { return XCTFail("expected parsed table") }
        XCTAssertEqual(table.header, ["파일", "설명"])
        XCTAssertEqual(table.rows.count, 1)
        let path = markdownInline(table.rows[0][0])
        XCTAssertEqual(String(path.characters), "~/docs/a.md")
        XCTAssertEqual(path.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, ["~/docs/a.md"])
        let text = markdownInline(table.rows[0][1])
        XCTAssertEqual(String(text.characters), "~ 취소선 웹")
        let struck = text.runs.filter { $0.inlinePresentationIntent?.contains(.strikethrough) == true }
        XCTAssertEqual(struck.map { String(text[$0.range].characters) }.joined(), "취소선")
        XCTAssertEqual(text.runs.compactMap { $0.link?.absoluteString }, ["https://example.com/path.md"])
        XCTAssertTrue(text.runs.allSatisfy { $0.link.flatMap(LocalFileLinks.path) == nil })
        let homeAndTilde = markdownInline("~/docs/a.md ~ 0.0~3.9 ~~취소선~~")
        XCTAssertEqual(String(homeAndTilde.characters), "~/docs/a.md ~ 0.0~3.9 취소선")
        XCTAssertEqual(homeAndTilde.runs.compactMap { $0.link.flatMap(LocalFileLinks.path) }, ["~/docs/a.md"])
    }
    func testLinkRoundTripKeepsUnicodeSpacesAndReservedQueryCharacters() throws {
        let path = "~/대본 폴더/a #1&b?.md"
        XCTAssertEqual(LocalFileLinks.path(try XCTUnwrap(LocalFileLinks.url(path))), path)
        XCTAssertNil(LocalFileLinks.path(try XCTUnwrap(URL(string: "https://example.com/?path=a.md"))))
    }
    func testPreviewAPIEncodesPathAndUsesAuthenticatedImageBytes() async throws {
        let metadata = Data(#"{"kind":"image","name":"영상.png","path":"/fixture/영상.png","size":3,"modifiedAt":"2026-11-08T00:00:00Z","mime":"image/png"}"#.utf8).base64EncodedString()
        let fixture = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            let parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(parts.queryItems?.first?.value, "~/대본 폴더/a#1&b.md")
            return IsolatedTestHTTPReply(data: Data([1, 2, 3]), headers: ["Content-Type": "image/png", "X-Local-File-Metadata": metadata])
        }
        let result = try await fixture.makeAPIClient().localFile(projectID: "p/?", path: "~/대본 폴더/a#1&b.md")
        XCTAssertEqual(result.info.name, "영상.png"); XCTAssertEqual(result.imageData, Data([1, 2, 3]))
        XCTAssertTrue(fixture.requests[0].url!.absoluteString.contains("p%2F%3F"))
        await fixture.close()
    }
    func testOldServer404ShowsUnsupportedWhileMissingAndForbiddenKeepServerReason() async throws {
        for (status, code, reason, expected) in [
            (404, "", "없는 경로입니다", "이 서버는 파일 보기를 지원하지 않습니다"),
            (404, "LOCAL_FILE_NOT_FOUND", "파일을 찾을 수 없습니다", "파일을 찾을 수 없습니다"),
            (403, "", "민감한 파일입니다", "민감한 파일입니다")
        ] {
            let fixture = try IsolatedTestNetwork { _ in
                IsolatedTestHTTPReply(status: status, data: Data("{\"error\":\"\(reason)\",\"code\":\"\(code)\"}".utf8))
            }
            do { _ = try await fixture.makeAPIClient().localFile(projectID: "p", path: "a.md"); XCTFail("must fail") }
            catch { XCTAssertEqual(error.localizedDescription, expected) }
            await fixture.close()
        }
    }

    /// n-files-9, n-chat-3: 지난 실행이 남긴 임시 폴더만 치운다. 최근 것, 이 앱이 만들지 않은 것은 건드리지 않는다.
    func testStaleTemporaryFoldersOfThisAppAreSweptAndEverythingElseIsLeft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-stab2-sweep-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let now = Date(), old = now.addingTimeInterval(-2 * 24 * 60 * 60)
        func make(_ name: String, modified: Date, file: Bool = false) throws -> URL {
            let url = root.appendingPathComponent(name)
            if file { try Data("x".utf8).write(to: url) }
            else {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try Data("payload".utf8).write(to: url.appendingPathComponent("a.png"))
            }
            try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
            return url
        }
        let stale = try [make("IAMCEO-cache-\(UUID().uuidString)", modified: old), make("IAMCEO-\(UUID().uuidString)", modified: old),
                         make("iamceo-photo-\(UUID())", modified: old), make("iamceo-promise-\(UUID())", modified: old)]
        let kept = try [make("IAMCEO-cache-\(UUID().uuidString)", modified: now.addingTimeInterval(-60)),
                        make("IAMCEO-cache-not-a-uuid", modified: old), make("IAMCEO-settings", modified: old),
                        make("someone-else-\(UUID().uuidString)", modified: old),
                        make("IAMCEO-\(UUID().uuidString)", modified: old, file: true)]
        XCTAssertEqual(TemporaryFiles.sweepStale(in: root, now: now), 4)
        for url in stale { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), url.lastPathComponent) }
        for url in kept { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), url.lastPathComponent) }
        XCTAssertEqual(TemporaryFiles.sweepStale(in: root, now: now), 0)
    }

    /// n-files-7: 경로 링크 처리 결과는 정규식을 한 번만 만들게 바꾼 뒤에도 같고, 같은 문단은 다시 해석하지 않는다.
    func testInlineMarkdownIsMemoisedAndMatchesAFreshParse() {
        let samples = ["`docs/spec.md` 와 ~/Downloads/영상.mp4, user@example.com, https://example.com/a.md.",
                       "굵게 **bold** 와 0.0~3.9 그리고 ~~지움~~", "src/views 를 고쳤습니다. and/or 는 그대로.", ""]
        for sample in samples {
            let fresh = markdownInlineUncached(sample)
            XCTAssertEqual(markdownInline(sample), fresh, sample)
            XCTAssertEqual(markdownInline(sample), fresh, sample)
        }
        let long = String(repeating: "긴 문단 docs/spec.md ", count: 400)
        XCTAssertEqual(markdownInline(long), markdownInlineUncached(long))
    }
}
