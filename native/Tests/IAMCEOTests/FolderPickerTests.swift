import Foundation
import XCTest
@testable import IAMCEO

final class FolderPickerTests: XCTestCase {
    func testFolderAndGitHubResponseDecoding() throws {
        let folders = try JSONDecoder().decode(FolderListing.self, from: Data(#"{"path":"/fake/home/code","parent":"/fake/home","home":"/fake/home","entries":[{"name":"한글 폴더","path":"/fake/home/code/한글 폴더"}],"truncated":true}"#.utf8))
        XCTAssertEqual(folders.entries.first?.name, "한글 폴더")
        XCTAssertEqual(folders.truncated, true)
        let home = try JSONDecoder().decode(FolderListing.self, from: Data(#"{"path":"/fake/home","parent":null,"home":"/fake/home","entries":[]}"#.utf8))
        XCTAssertNil(home.parent); XCTAssertNil(home.truncated)
        let unavailable = try JSONDecoder().decode(GitHubRepositories.self, from: Data(#"{"available":false,"reason":"login"}"#.utf8))
        XCTAssertFalse(unavailable.available)
        let repos = try JSONDecoder().decode(GitHubRepositories.self, from: Data(#"{"available":true,"repos":[{"nameWithOwner":"owner/repo","description":null,"visibility":"PRIVATE","updatedAt":"2026-11-06T10:00:00Z","url":"https://github.com/owner/repo"}]}"#.utf8))
        XCTAssertEqual(repos.repos.first?.id, "owner/repo")
        let done = try JSONDecoder().decode(GitHubCloneJob.self, from: Data(#"{"status":"done","path":"/fake/home/repo"}"#.utf8))
        XCTAssertEqual(done.status, .done); XCTAssertEqual(done.path, "/fake/home/repo")
    }
    func testBreadcrumbsUseServerHomeAndNeverSiblingPrefix() {
        XCTAssertEqual(ServerFolderPaths.breadcrumbs(path: "/server/home/코드/앱", home: "/server/home"), [
            FolderCrumb(name: "홈", path: "/server/home"), FolderCrumb(name: "코드", path: "/server/home/코드"), FolderCrumb(name: "앱", path: "/server/home/코드/앱")
        ])
        XCTAssertEqual(ServerFolderPaths.breadcrumbs(path: "/server/home", home: "/server/home").count, 1)
        XCTAssertTrue(ServerFolderPaths.breadcrumbs(path: "/server/home-other", home: "/server/home").isEmpty)
        XCTAssertEqual(ServerFolderPaths.parent("~/code/project"), "~/code")
    }
    func testNameAndRepositoryValidationMatchesServerRules() {
        for name in ["새 폴더", "  공백 허용  ", "a".padding(toLength: 100, withPad: "a", startingAt: 0)] { XCTAssertNil(ServerFolderPaths.nameError(name), name) }
        for name in ["", " ", ".", "..", ".hidden", "a/b", "a\u{0}b", "a\nb", String(repeating: "가", count: 101)] { XCTAssertNotNil(ServerFolderPaths.nameError(name), name) }
        for repo in ["owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git"] { XCTAssertEqual(ServerFolderPaths.repository(repo), "owner/repo") }
        for repo in ["-option/repo", "https://other.com/o/r", "http://github.com/o/r", "../r", "o/a b", "o/r\n"] { XCTAssertNil(ServerFolderPaths.repository(repo), repo) }
    }
    func testOnlyMissingFolderEndpointEnablesLegacyInput() async throws {
        let old = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        if case .legacy = try await old.makeAPIClient().folderBrowser() { } else { XCTFail("404 must allow manual paths") }
        for status in [401, 403, 500] {
            let refused = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: status) }
            do { _ = try await refused.makeAPIClient().folderBrowser(); XCTFail("Refusal must not enable manual paths") }
            catch let error as APIError { XCTAssertEqual(error.status, status) }
        }
        let missingFolder = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        do { _ = try await missingFolder.makeAPIClient().folderContents(path: "/missing"); XCTFail("A missing folder must remain an error") }
        catch let error as APIError { XCTAssertEqual(error.status, 404) }
    }
    func testFolderPathsEncodedAndGitHubCloneIsTwoStep() async throws {
        let network = try IsolatedTestNetwork { request in
            switch request.url!.path {
            case "/api/folders":
                if request.httpMethod == "POST" { return IsolatedTestHTTPReply(data: Data(#"{"name":"새 폴더","path":"/server/home/새 폴더"}"#.utf8)) }
                return IsolatedTestHTTPReply(data: Data(#"{"path":"/server/home","parent":null,"home":"/server/home","entries":[]}"#.utf8))
            case "/api/github/clone": return IsolatedTestHTTPReply(status: 202, data: Data(#"{"jobId":"fixture-job"}"#.utf8))
            case "/api/github/clone/fixture-job": return IsolatedTestHTTPReply(data: Data(#"{"status":"done","path":"/server/home/repo"}"#.utf8))
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
        let api = network.makeAPIClient()
        _ = try await api.folderContents(path: "/server/home/한글 & ?")
        let request = try XCTUnwrap(network.requests.first)
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first?.value, "/server/home/한글 & ?")
        let created = try await api.createFolder(parent: "/server/home", name: "새 폴더")
        XCTAssertEqual(created.name, "새 폴더")
        let id = try await api.cloneRepository(repo: "owner/repo", parent: "/server/home")
        XCTAssertEqual(id, "fixture-job")
        let job = try await api.cloneJob(id)
        XCTAssertEqual(job.status, .done)
    }
    @MainActor func testDemoTreeAndReposNeverSendRequestsAndRefuseWrites() async throws {
        let network = try IsolatedTestNetwork { _ in XCTFail("Demo must not use the network"); return IsolatedTestHTTPReply(status: 500) }
        let store = AppStore(demo: true, session: network.session, persistCredentials: false)
        if case .listing(let home) = try await store.folderBrowser() {
            XCTAssertEqual(home.home, "/Users/demo"); XCTAssertEqual(home.entries.count, 2)
        } else { XCTFail("Demo needs a folder tree") }
        let code = try await store.folderContents(path: "/Users/demo/code")
        XCTAssertFalse(code.entries.isEmpty)
        let repositories = try await store.githubRepositories()
        XCTAssertEqual(repositories.repos.count, 2)
        do { _ = try await store.createServerFolder(parent: "/Users/demo", name: "new"); XCTFail("Demo wrote folder") } catch { }
        do { _ = try await store.startRepositoryClone(repo: "owner/repo", parent: "/Users/demo"); XCTFail("Demo cloned repository") } catch { }
        XCTAssertTrue(network.requests.isEmpty)
    }
}
