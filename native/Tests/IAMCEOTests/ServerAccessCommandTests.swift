import Foundation
import XCTest
@testable import IAMCEO

/// 연결 화면 아래 칩의 명령. 앱으로 설치한 서버는 PATH 에 iamceo 가 없으므로 앱 안 경로로 된 명령을 보이고,
/// git 체크아웃·직접 깐 명령줄 도구처럼 그 밖이거나 모를 때는 예전 문구 그대로다.
@MainActor
final class ServerAccessCommandTests: XCTestCase {
    private let app = "/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo"

    func testAppInstalledServerUsesTheAppsOwnExecutable() {
        // 서버가 Bootstrap.cli 로 알려 준 명령(서버의 shellQuote 를 거친 실행 파일 경로)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: app, serviceProgram: nil), "\(app) open")
        let spaced = "'/Users/a/Applications/IAMCEO 2.app/Contents/Resources/runtime/iamceo'"
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: spaced, serviceProgram: nil), "\(spaced) open")
        let quote = "'/Users/a/O'\\''Neil/IAMCEO.app/Contents/Resources/runtime/iamceo'"
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: quote, serviceProgram: nil), "\(quote) open")
        // 서버를 모를 때는 이 Mac 에 등록된 서비스가 앱 안 실행 파일로 serve 하는지 본다.
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: nil, serviceProgram: [app, "serve"]), "\(app) open")
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "", serviceProgram: ["/Users/a/My Apps/IAMCEO.app/Contents/Resources/runtime/iamceo", "serve"]),
                       "'/Users/a/My Apps/IAMCEO.app/Contents/Resources/runtime/iamceo' open")
        XCTAssertTrue(ServerAccessCommand.isLong(ServerAccessCommand.command(serverCLI: app, serviceProgram: nil)))
    }

    func testEverythingElseKeepsTheShortCommand() {
        let plain = ServerAccessCommand.plain
        XCTAssertEqual(plain, "iamceo open")
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: nil, serviceProgram: nil), plain)
        // PATH 에 iamceo 가 있는 서버, git 체크아웃(bun + 소스 경로) 서버
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "iamceo", serviceProgram: nil), plain)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "/opt/homebrew/bin/bun /Users/a/iamceo/bin/iamceo.ts", serviceProgram: nil), plain)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "'/Users/a/b c/bun' /Users/a/iamceo/bin/iamceo.ts", serviceProgram: nil), plain)
        // 서버가 알려 준 것이 있으면 그것으로만 정한다(이 Mac 의 서비스가 다른 설치여도 덮어쓰지 않는다).
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "iamceo", serviceProgram: [app, "serve"]), plain)
        // 서비스가 앱 안 실행 파일이 아니거나 serve 가 아니면 예전 문구
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: nil, serviceProgram: ["/opt/homebrew/bin/bun", "/Users/a/iamceo/bin/iamceo.ts", "serve"]), plain)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: nil, serviceProgram: [app, "mcp"]), plain)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: nil, serviceProgram: ["IAMCEO.app/Contents/Resources/runtime/iamceo", "serve"]), plain)
        // 따옴표가 깨졌거나 두 낱말이면 믿지 않는다.
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "'\(app)", serviceProgram: nil), plain)
        XCTAssertEqual(ServerAccessCommand.command(serverCLI: "\(app) serve", serviceProgram: nil), plain)
        XCTAssertFalse(ServerAccessCommand.isLong(plain))
    }

    /// 마지막으로 붙은 서버가 알려 준 명령을 저장된 연결과 함께 기억해, 그 서버에 닿지 않을 때도 연결 화면이 맞는 명령을 보인다.
    /// 나가기를 하면 주소 기억과 함께 지운다.
    func testStoreRemembersTheServersCommandWithTheSavedConnection() async throws {
        let server = WriteTestServer()
        server.change { $0.bootstrap.cli = self.app }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "iamceo.server-cli.\(UUID().uuidString)"))
        let store = AppStore(session: network.session, persistCredentials: false, navigationDefaults: defaults)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.serverCLI(for: network.endpoint.url.absoluteString), app)
        XCTAssertEqual(defaults.stringArray(forKey: "iamceo.serverCLI.v1")?.last, app)
        // 다른 서버 주소에는 기억한 명령을 쓰지 않는다.
        XCTAssertNil(store.serverCLI(for: "http://100.64.0.9:7878"))

        // 새 앱 실행(같은 저장소, 아직 연결 전)에서도 그 주소의 명령을 안다.
        let later = AppStore(session: network.session, persistCredentials: false, navigationDefaults: defaults)
        XCTAssertEqual(later.serverCLI(for: network.endpoint.url.absoluteString), app)

        store.disconnect()
        XCTAssertNil(defaults.stringArray(forKey: "iamceo.serverCLI.v1"))
        XCTAssertNil(store.serverCLI(for: network.endpoint.url.absoluteString))
        await network.close()
    }
}
