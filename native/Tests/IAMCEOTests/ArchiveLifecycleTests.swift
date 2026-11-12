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

    /// 리뷰 app-5: 보관함 시트에는 상태 띠가 없어, 지우기에 실패하면 이유를 시트 안 알림 자리에 보인다.
    func testADeleteFailureIsShownInsideTheSheet() async throws {
        let server = ManagementNavigationServer()
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "DELETE" { return IsolatedTestHTTPReply(status: 405, data: Data(#"{"error":"허용되지 않는 메서드입니다"}"#.utf8)) }
            return try server.handle(request)
        }
        let store = await connected(network); defer { store.disconnect() }
        await store.loadArchivedProjects()
        let deleted = await store.deleteArchivedProject(id: "a")
        XCTAssertFalse(deleted)
        let notice = ArchiveExport.deleteFailure(store.errorMessage)
        XCTAssertTrue(notice.failed)
        XCTAssertEqual(notice.title, "지우지 못했습니다")
        XCTAssertEqual(notice.detail, "서버가 옛 버전이라 프로젝트를 지울 수 없습니다. 서버를 업데이트한 뒤 다시 해 주세요.")
        XCTAssertNil(notice.file)
        XCTAssertEqual(ArchiveExport.deleteFailure(nil).detail, "잠시 뒤 다시 해 주세요.")
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

    /// 리뷰 safety-1: 소스 체크아웃(대표 라이브)·옛 명령줄 설치의 서비스는 이 앱이 멈추지 않는다. LocalHostService 와 같은 판정이다.
    func testFullStopIsOfferedOnlyForTheAppsOwnServiceOrNone() {
        let daemon = "/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo"
        let home = URL(fileURLWithPath: "/Users/someone/.iamceo"), defaultHome = home
        func owns(_ plist: [String: Any]?, dataHome: URL = home) -> Bool {
            FullStopRunner.ownsRegisteredService(plist: plist, daemonPath: daemon, dataHome: dataHome, defaultHome: defaultHome)
        }
        func plist(_ program: [String], home: String? = nil, label: String = "com.iamceo.server") -> [String: Any] {
            var value: [String: Any] = ["Label": label, "ProgramArguments": program]
            if let home { value["EnvironmentVariables"] = ["IAMCEO_HOME": home] }
            return value
        }
        XCTAssertTrue(owns(nil), "등록된 서비스가 없으면 멈출 서비스가 없다")
        XCTAssertTrue(owns(plist([daemon, "serve"])))
        XCTAssertTrue(owns(plist([daemon, "serve"], home: "/Users/someone/.iamceo/")))
        XCTAssertFalse(owns(plist(["/Users/someone/.bun/bin/bun", "/Users/someone/iamceo/bin/iamceo.ts", "serve"])), "소스 체크아웃(라이브)")
        XCTAssertFalse(owns(plist(["/opt/homebrew/bin/iamceo", "serve"])), "옛 명령줄 설치")
        XCTAssertFalse(owns(plist(["/Applications/Other.app/Contents/Resources/runtime/iamceo", "serve"])), "다른 앱")
        XCTAssertFalse(owns(plist([daemon, "serve"], home: "/Users/someone/other")), "다른 데이터 폴더")
        XCTAssertFalse(owns(plist([daemon, "serve"], label: "com.other")))
        XCTAssertFalse(owns([:]), "읽지 못한 설정은 이 앱의 것이 아니다")
        // '이 Mac에서 시작으로 다시 켤 수 있다'는 이 앱의 서비스를 지웠을 때만.
        XCTAssertTrue(FullStopRunner.stoppedMessage(removedAppService: true).contains("‘이 Mac에서 시작’"))
        XCTAssertFalse(FullStopRunner.stoppedMessage(removedAppService: false).contains("이 Mac에서 시작"))
    }

    /// 리뷰 app-8: 서비스 설정이 이미 없어도 엔진을 끌 수 있게 앱 안의 엔진 자리를 넘긴다(이미 정해져 있으면 그대로).
    func testFullStopPassesTheBundledEngine() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-fullstop-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let daemon = root.appendingPathComponent("runtime/iamceo")
        let core = root.appendingPathComponent("runtime/Herdr Core.app/Contents/MacOS/herdr-core")
        try FileManager.default.createDirectory(at: core.deletingLastPathComponent(), withIntermediateDirectories: true)
        XCTAssertNil(FullStopRunner.childEnvironment([:], daemon: daemon)["IAMCEO_CORE_BIN"], "엔진이 없으면 넘기지 않는다")
        FileManager.default.createFile(atPath: core.path, contents: Data(), attributes: [.posixPermissions: 0o755])
        let environment = FullStopRunner.childEnvironment(["PATH": "/usr/bin"], daemon: daemon)
        XCTAssertEqual(environment["IAMCEO_CORE_BIN"], core.path)
        XCTAssertEqual(environment["IAMCEO_LANG"], "ko")
        XCTAssertEqual(environment["PATH"], "/usr/bin")
        XCTAssertEqual(FullStopRunner.childEnvironment(["IAMCEO_CORE_BIN": "/qa/herdr-core"], daemon: daemon)["IAMCEO_CORE_BIN"], "/qa/herdr-core")
    }

    /// 리뷰 app-4·app-7: 다른 Mac 의 서버에 붙은 Mac 에서는 데이터를 지워도 그 서버와의 연결을 지우지 않고,
    /// 서버가 받지 않는 내보내기는 보이지 않는다.
    func testAnotherMacsServerKeepsItsConnectionAndHasNoExport() {
        XCTAssertTrue(FullStopGroup.leavesConnection(afterPurgeOnThisMac: true))
        XCTAssertFalse(FullStopGroup.leavesConnection(afterPurgeOnThisMac: false))
        XCTAssertTrue(FullStopGroup.purgeHint(serverIsThisMac: false).contains("이 Mac의 데이터만 지웁니다"))
        XCTAssertTrue(FullStopGroup.stopHint(serverIsThisMac: false).contains("이 Mac의 IAMCEO만 멈춥니다"))
        XCTAssertEqual(FullStopGroup.purgeHint(serverIsThisMac: true), "대화·결재·자료·첨부와 백업을 이 Mac에서 지웁니다. 되돌릴 수 없습니다")
        XCTAssertTrue(ArchiveExport.canExport(serverIsThisMac: true))
        XCTAssertFalse(ArchiveExport.canExport(serverIsThisMac: false))
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
