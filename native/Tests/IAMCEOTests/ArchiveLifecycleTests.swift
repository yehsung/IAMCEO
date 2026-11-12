import Foundation
import XCTest
@testable import IAMCEO

/// B 묶음(앱): 보관함의 지우기·내보내기와 설정의 '이 Mac에서 완전히 멈추기'.
/// 모든 요청은 IsolatedTestNetwork 가 가로챈다. 실제 서버·실행 파일을 부르지 않는다.
@MainActor final class ArchiveLifecycleTests: XCTestCase {
    private func connected(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, writeStorageURL: nil)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        return store
    }

    func testDeletingTheOpenArchivedProjectRemovesItAndReturnsToHQ() async throws {
        let server = ManagementNavigationServer()
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "DELETE", request.url?.path == "/api/projects/a" {
                server.change { $0.projects["a"] = nil }
                return IsolatedTestHTTPReply(data: Data(#"{"id":"a","deleted":true,"removedAttachments":2}"#.utf8))
            }
            return try server.handle(request)
        }
        let store = await connected(network); defer { store.disconnect() }
        await store.loadArchivedProjects()
        XCTAssertEqual(store.archivedProjects.map(\.id), ["a"])
        await store.selectArchivedProject(id: "a")
        XCTAssertTrue(store.isArchive)
        let deleted = await store.deleteArchivedProject(id: "a")
        XCTAssertTrue(deleted)
        XCTAssertTrue(store.archivedProjects.isEmpty)
        XCTAssertEqual(store.selectedProjectID, "hq")
        XCTAssertFalse(store.isArchive)
        XCTAssertEqual(store.projectNotice, "프로젝트를 지웠습니다.")
        let requests = network.requests.filter { $0.httpMethod == "DELETE" }
        XCTAssertEqual(requests.map { $0.url?.path }, ["/api/projects/a"])
        await network.close()
    }

    func testAnOlderServerThatCannotDeleteLeavesTheArchiveAsItWas() async throws {
        let server = ManagementNavigationServer()
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "DELETE" {
                return IsolatedTestHTTPReply(status: 405, data: Data(#"{"error":"허용되지 않는 메서드입니다"}"#.utf8))
            }
            return try server.handle(request)
        }
        let store = await connected(network); defer { store.disconnect() }
        await store.loadArchivedProjects()
        let deleted = await store.deleteArchivedProject(id: "a")
        XCTAssertFalse(deleted)
        XCTAssertEqual(store.archivedProjects.map(\.id), ["a"])
        XCTAssertEqual(store.errorMessage, "서버가 옛 버전이라 프로젝트를 지울 수 없습니다. 서버를 업데이트한 뒤 다시 해 주세요.")
        await network.close()
    }

    func testExportDownloadsTheZipToAFileAndExplainsRefusals() async throws {
        let zip = Data([0x50, 0x4b, 0x05, 0x06] + Array(repeating: 0, count: 18))
        let reply = ExportReplyBox()
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/projects/a/export")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            return reply.next(zip)
        }
        let api = network.makeAPIClient()
        let file = try await api.exportProject(id: "a")
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(try Data(contentsOf: file), zip)
        XCTAssertEqual(file.pathExtension, "zip")
        do { _ = try await api.exportProject(id: "a"); XCTFail("다른 기기의 내보내기는 거절된다") }
        catch {
            XCTAssertEqual((error as? APIError)?.code, "LOCAL_ONLY")
            XCTAssertEqual(ArchiveExport.friendly(error), "내보내기는 서버가 도는 Mac에서만 할 수 있습니다.")
        }
        do { _ = try await api.exportProject(id: "a"); XCTFail("옛 서버에는 경로가 없다") }
        catch { XCTAssertEqual(ArchiveExport.friendly(error), "서버가 옛 버전이라 내보낼 수 없습니다. 서버를 업데이트한 뒤 다시 해 주세요.") }
        await network.close()
    }

    func testDeleteResultDecodesWithoutTheOptionalCount() throws {
        let full = try JSONDecoder().decode(ProjectDeleteResult.self, from: Data(#"{"id":"a","deleted":true,"removedAttachments":3}"#.utf8))
        XCTAssertEqual(full.removedAttachments, 3)
        let bare = try JSONDecoder().decode(ProjectDeleteResult.self, from: Data(#"{"id":"a","deleted":true}"#.utf8))
        XCTAssertNil(bare.removedAttachments)
    }

    func testSuggestedExportNameIsAFileName() {
        let noon = Date(timeIntervalSince1970: 1_794_571_200) // 2026-11-13 12:00 UTC
        let name = ArchiveExport.suggestedName(for: Project(id: "a", name: "결제/화면 정리"), now: noon)
        XCTAssertTrue(name.hasPrefix("IAMCEO-결제_화면-정리-2026-11-1"), name)
        XCTAssertTrue(name.hasSuffix(".zip"))
        XCTAssertFalse(name.contains("/"))
        XCTAssertTrue(ArchiveExport.suggestedName(for: Project(id: "b", name: ""), now: noon).hasPrefix("IAMCEO-project-"))
    }

    #if os(macOS)
    func testFullStopUsesTheBundledUninstallAndKeepsDataUnlessAskedAgain() {
        XCTAssertEqual(FullStopRunner.arguments(purge: false), ["uninstall", "--yes"])
        XCTAssertEqual(FullStopRunner.arguments(purge: true), ["uninstall", "--purge", "--yes"])
        XCTAssertEqual(FullStopRunner.lastLine(Data("1단계\n\n서비스 밖에서 실행 중인 IAMCEO 서버가 있습니다\n  \n".utf8)), "서비스 밖에서 실행 중인 IAMCEO 서버가 있습니다")
        XCTAssertNil(FullStopRunner.lastLine(Data()))
        // 시험 실행 파일(swift test)은 .app 이 아니고 IAMCEO_DAEMON_BIN 도 없으니 줄을 보이지 않는다.
        XCTAssertNil(FullStopRunner.daemon(environment: [:]))
        XCTAssertNil(FullStopRunner.daemon(environment: ["IAMCEO_DAEMON_BIN": "relative/iamceo"]))
    }

    func testFullStopRefusesWithoutTheBundledServer() async {
        let runner = FullStopRunner()
        guard FullStopRunner.daemon() == nil else { return }
        await runner.stop()
        XCTAssertFalse(runner.stopped)
        XCTAssertTrue(runner.failed)
        XCTAssertEqual(runner.message, "실행 파일이 들어 있는 IAMCEO 앱에서만 할 수 있습니다.")
        let purged = await runner.purge()
        XCTAssertFalse(purged, "멈추기 전에는 데이터를 지우지 않는다")
    }
    #endif
}

/// 차례대로 200(zip) → 403(LOCAL_ONLY) → 404(옛 서버) 를 답한다.
private final class ExportReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next(_ zip: Data) -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        count += 1
        switch count {
        case 1: return IsolatedTestHTTPReply(status: 200, data: zip, headers: ["Content-Type": "application/zip"])
        case 2: return IsolatedTestHTTPReply(status: 403, data: Data(#"{"error":"프로젝트 내보내기는 이 Mac 에서만 할 수 있습니다","code":"LOCAL_ONLY"}"#.utf8))
        default: return IsolatedTestHTTPReply(status: 404, data: Data(#"{"error":"없는 경로입니다"}"#.utf8))
        }
    }
}
