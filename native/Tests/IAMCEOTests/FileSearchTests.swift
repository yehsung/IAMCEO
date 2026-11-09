import Foundation
import XCTest
@testable import IAMCEO

final class FileSearchTests: XCTestCase {
    func testServerSearchUsesOneAuthenticatedV2RequestAndPresentsBodyExcerptInRankOrder() async throws {
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/projects/p/files/search")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-IAMCEO-Contract"), "2")
            let parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            XCTAssertEqual(parts.queryItems?.first { $0.name == "q" }?.value, "결제 실패 & ?#%")
            XCTAssertEqual(parts.queryItems?.first { $0.name == "limit" }?.value, "200")
            return IsolatedTestHTTPReply(data: Data(#"[{"id":"body","match":"body","excerpt":"앞 결제 실패 화면 문구 뒤","rank":2},{"id":"title","match":"title","excerpt":"결제 실패","rank":1}]"#.utf8))
        }
        let files = [FileDoc(id: "body", kind: "document", projectId: "p"), FileDoc(id: "title", kind: "table", projectId: "p"), FileDoc(id: "other", projectId: "p")]
        let results = try await network.makeAPIClient().searchFilesWithFallback(projectID: "p", query: "결제 실패 & ?#%", files: files)
        let display = FileSearchPresentation(results: results)
        XCTAssertEqual(display.files(files, kind: nil).map(\.id), ["title", "body"])
        XCTAssertEqual(display.files(files, kind: "document").map(\.id), ["body"])
        XCTAssertEqual(display.result(for: "body")?.bodyLabel, "본문에서 찾음")
        XCTAssertEqual(display.result(for: "body")?.excerpt, "앞 결제 실패 화면 문구 뒤")
        XCTAssertNil(display.result(for: "title")?.bodyLabel)
        XCTAssertEqual(network.requests.count, 1)
        await network.close()
    }

    func testOnly404And501FallBackToLegacyBodies() async throws {
        for status in [404, 501] {
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasSuffix("/search") == true { return IsolatedTestHTTPReply(status: status) }
                XCTAssertEqual(request.url?.path, "/api/files/f")
                return IsolatedTestHTTPReply(data: Data(#"{"id":"f","projectId":"p","body":"결제 실패 화면 문구"}"#.utf8))
            }
            let results = try await network.makeAPIClient().searchFilesWithFallback(projectID: "p", query: "결제 실패", files: [FileDoc(id: "f", projectId: "p"), FileDoc(id: "foreign", projectId: "other")])
            XCTAssertEqual(results.map(\.id), ["f"])
            XCTAssertEqual(results.first?.bodyLabel, "본문에서 찾음")
            XCTAssertEqual(network.requests.count, 2)
            await network.close()
        }
        for status in [400, 401, 403, 500] {
            let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: status) }
            do {
                _ = try await network.makeAPIClient().searchFilesWithFallback(projectID: "p", query: "결제 실패", files: [FileDoc(id: "f", projectId: "p")])
                XCTFail("must preserve server failure")
            } catch let error as APIError { XCTAssertEqual(error.status, status) }
            XCTAssertEqual(network.requests.count, 1)
            await network.close()
        }
    }

    func testArchiveSearchUsesArchiveBoundaryAndLegacyArchiveDoesNotFetchBodies() async throws {
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.url?.path, "/api/projects/p/archive/files/search")
            return IsolatedTestHTTPReply(status: 404)
        }
        let results = try await network.makeAPIClient().searchFilesWithFallback(projectID: "p", query: "결제 실패", files: [FileDoc(id: "f", projectId: "p", body: "결제 실패 화면 문구")], archived: true)
        XCTAssertEqual(results.first?.bodyLabel, "본문에서 찾음")
        XCTAssertEqual(network.requests.count, 1)
        await network.close()
    }

    func testEmptyQueryDoesNotRequestAndEmptyServerResultsDoNotFallBack() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data("[]".utf8)) }
        let api = network.makeAPIClient()
        let files = [FileDoc(id: "f", projectId: "p", body: "결제 실패")]
        let empty = try await api.searchFilesWithFallback(projectID: "p", query: "", files: files)
        XCTAssertTrue(empty.isEmpty)
        XCTAssertTrue(network.requests.isEmpty)
        let missing = try await api.searchFilesWithFallback(projectID: "p", query: "결제 실패", files: files)
        XCTAssertTrue(missing.isEmpty)
        XCTAssertEqual(network.requests.count, 1)
        await network.close()
    }
}
