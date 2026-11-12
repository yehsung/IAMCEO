import Foundation
import Observation

struct LocalHostConnection: Sendable, Equatable {
    let url: URL
    let accessCode: String
}

/// D1: 이 Mac 에서 앱이 직접 관리하는 서버가 앱에 든 서버보다 옛 버전이다. 한 번 묻고 다시 시작한다.
struct ServerUpgradeOffer: Sendable, Equatable {
    let runningVersion: String
    let bundledVersion: String
    /// 앱에 든 서버 실행 파일의 build ID. 같은 앱 빌드에는 다시 묻지 않는 기준이다.
    let bundledBuildID: String
}

/// Starting the local host is an explicit onboarding action, never an app-start side effect.
@MainActor @Observable
final class LocalHostService {
    private(set) var isStarting = false
    private(set) var statusText = ""

    func start() async throws -> LocalHostConnection {
        #if os(macOS)
        guard !isStarting else { throw LocalHostError("이미 이 Mac의 실행 환경을 준비하고 있습니다.") }
        isStarting = true
        defer { isStarting = false }
        let environment = ProcessInfo.processInfo.environment
        let dataHome = Self.dataHome(environment: environment)
        let resources = try Self.runtimeResources(environment: environment)
        let expectedBuildID = try await Self.buildID(resources.daemon, environment: environment)
        statusText = "기존 로컬 연결을 확인하는 중"
        var hadConnection = false
        if let current = try Self.readConnection(dataHome: dataHome, environment: environment) {
            hadConnection = true
            let client = try Self.client(current)
            var slowAnswers = 0
            existing: while true {
                do {
                    let coreAvailable = try await Self.checkHealth(client, expectedBuildID: expectedBuildID, readinessTimeout: 15, bootstrapTimeout: 30)
                    statusText = coreAvailable ? "이 Mac에 연결했습니다" : "이 Mac에 연결했습니다 · core 연결을 확인하세요"
                    return current
                } catch let error as URLError where error.code == .cannotConnectToHost {
                    // Only a refused connection means it is safe to attempt a new local host.
                    break existing
                } catch let error as URLError where error.code == .timedOut {
                    // 응답이 늦을 뿐 서버는 떠 있다. 서비스를 건드리지 않고 한 번 더 기다린다.
                    slowAnswers += 1
                    guard slowAnswers < 2 else {
                        throw LocalHostError("이 Mac의 서버가 바빠 응답이 늦습니다. 실행 중인 서비스는 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.")
                    }
                    try Task.checkCancellation()
                    statusText = "서버 응답을 기다리는 중"
                } catch let error as APIError where error.status == 503 {
                    // 서버가 뜨는 중이다(STARTING). 서비스는 건드리지 않고 준비될 때까지 기다린다.
                    statusText = "서버가 준비되기를 기다리는 중"
                    if let connection = try await awaitReady(dataHome: dataHome, environment: environment, expectedBuildID: expectedBuildID, attempts: 60, within: .seconds(30)) {
                        return connection
                    }
                    throw LocalHostError("이 Mac의 서버가 아직 준비 중입니다. 실행 중인 서비스는 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.")
                } catch let error as LocalHostError { throw error }
                catch {
                    throw LocalHostError("기존 로컬 서버에 응답 또는 인증 문제가 있습니다. 실행 중인 서비스를 바꾸지 않았습니다. 연결 설정을 확인하세요.")
                }
            }
        } else {
            try await Self.requireUnusedPort(Self.port(environment: environment, configured: nil))
        }
        let target = "gui/\(getuid())/com.iamceo.server"
        if try await Self.run(URL(fileURLWithPath: "/bin/launchctl"), arguments: ["print", target], environment: environment, timeout: 15) == 0 {
            // 등록된 서비스가 다시 뜨는 중(재시작·배포 직후)일 수 있다. 서비스는 건드리지 않고 잠시 기다려 본다.
            if hadConnection {
                statusText = "서버가 다시 뜨기를 기다리는 중"
                if let connection = try await awaitReady(dataHome: dataHome, environment: environment, expectedBuildID: expectedBuildID, attempts: 60, within: .seconds(30)) {
                    return connection
                }
            }
            throw LocalHostError("이미 등록된 IAMCEO 서비스가 있습니다. 기존 서비스의 연결 문제를 먼저 확인하세요. 실행 중인 서비스는 교체하지 않았습니다.")
        }
        try Self.requireOwnedPlist(daemon: resources.daemon, dataHome: dataHome)
        var launchEnvironment = environment
        launchEnvironment["IAMCEO_HOME"] = dataHome.path
        launchEnvironment["IAMCEO_CORE_BIN"] = resources.core.path
        statusText = "이 Mac의 실행 서비스를 준비하는 중"
        // service install 은 서버 준비를 30초까지 기다린 뒤 끝난다.
        let status = try await Self.run(resources.daemon, arguments: ["service", "install"], environment: launchEnvironment, timeout: 90)
        guard status == 0 else {
            throw LocalHostError("로컬 서비스 등록을 완료하지 못했습니다 (종료 코드 \(status)). 기존 설치의 서비스 설정을 확인하세요.")
        }
        statusText = "서버가 준비되기를 기다리는 중"
        if let connection = try await awaitReady(dataHome: dataHome, environment: environment, expectedBuildID: expectedBuildID, attempts: 60, within: .seconds(120)) {
            return connection
        }
        throw LocalHostError("로컬 서버가 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하거나 ~/.iamceo/logs의 서버 로그를 확인하세요.")
        #else
        throw LocalHostError("로컬 실행은 Mac 앱에서 시작할 수 있습니다. iPhone에서는 실행 중인 Mac에 연결하세요.")
        #endif
    }

    // MARK: D1 앱을 올리면 서버도

    #if os(macOS)
    private static var bundledIdentity: (path: String, buildID: String, version: String)?
    /// 이 Mac 서비스(com.iamceo.server)의 설정 파일.
    nonisolated static var servicePlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.iamceo.server.plist")
    }
    #endif

    /// '옛 버전 서버를 앱의 새 서버로 다시 시작'을 물어도 되는지 정한다. 모두 맞을 때만 제안한다.
    /// - 연결한 주소가 이 Mac(127.0.0.1)이고, 포트가 이 데이터 홈의 설정과 같다.
    /// - 등록된 서비스가 **이 앱 안의 실행 파일**을 `serve` 로 돌리고 같은 데이터 홈을 쓴다(앱이 직접 관리하는 설치판).
    ///   git 체크아웃에서 도는 서버(bun 과 소스 경로로 등록된 서비스)는 여기서 걸러져 절대 묻지도 다시 시작하지도 않는다.
    /// - 도는 서버의 build ID 가 앱에 든 것과 다르고, 버전이 정식 번호로 **더 낮다**(같거나 높으면 되돌림이 될 수 있어 묻지 않는다).
    nonisolated static func upgradeOffer(endpoint: String, configuredPort: Int, plist: [String: Any]?, daemonPath: String, dataHome: URL,
                                         defaultHome: URL, running: (buildID: String, version: String)?,
                                         bundled: (buildID: String, version: String)) -> ServerUpgradeOffer? {
        guard managesService(endpoint: endpoint, configuredPort: configuredPort, plist: plist, daemonPath: daemonPath,
                             dataHome: dataHome, defaultHome: defaultHome) else { return nil }
        guard let running, !running.buildID.isEmpty, running.buildID != bundled.buildID,
              let from = ReleaseVersion(running.version), let to = ReleaseVersion(bundled.version), from < to else { return nil }
        return ServerUpgradeOffer(runningVersion: running.version, bundledVersion: bundled.version, bundledBuildID: bundled.buildID)
    }

    /// 연결한 주소가 이 Mac 의 그 데이터 홈 서버이고, 그 서비스가 이 앱 안의 실행 파일로 등록돼 있는가.
    nonisolated static func managesService(endpoint: String, configuredPort: Int, plist: [String: Any]?, daemonPath: String,
                                           dataHome: URL, defaultHome: URL) -> Bool {
        guard let parts = URLComponents(string: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              ["127.0.0.1", "localhost", "::1", "[::1]"].contains(parts.host?.lowercased() ?? ""),
              (parts.port ?? (parts.scheme?.lowercased() == "https" ? 443 : 80)) == configuredPort else { return false }
        guard let plist, plist["Label"] as? String == "com.iamceo.server",
              plist["ProgramArguments"] as? [String] == [daemonPath, "serve"] else { return false }
        let environment = plist["EnvironmentVariables"] as? [String: String]
        let ownerHome = environment?["IAMCEO_HOME"].map { URL(fileURLWithPath: $0).standardizedFileURL } ?? defaultHome.standardizedFileURL
        return ownerHome.path == dataHome.standardizedFileURL.path
    }

    #if os(macOS)
    /// 지금 붙은 서버가 이 앱이 관리하는 옛 버전 서버인지 본다. 하나라도 확인하지 못하면 nil(묻지 않는다).
    /// 서비스·파일·서버를 바꾸지 않는다(읽기만).
    static func checkServerUpgrade(endpoint: String) async -> ServerUpgradeOffer? {
        let environment = ProcessInfo.processInfo.environment
        let dataHome = dataHome(environment: environment)
        guard let resources = try? runtimeResources(environment: environment),
              let connection = try? readConnection(dataHome: dataHome, environment: environment),
              let configuredPort = connection.url.port,
              let data = try? Data(contentsOf: servicePlistURL),
              let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] else { return nil }
        let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".iamceo", isDirectory: true)
        // 실행 파일을 부르기 전에 주소·서비스 소유부터 거른다(git 체크아웃 서버면 여기서 끝난다).
        guard managesService(endpoint: endpoint, configuredPort: configuredPort, plist: plist, daemonPath: resources.daemon.path,
                             dataHome: dataHome, defaultHome: defaultHome) else { return nil }
        // 앱에 든 실행 파일은 이 앱이 떠 있는 동안 바뀌지 않는다. 다시 연결할 때마다 수십 MB 를 다시 읽지 않는다.
        if bundledIdentity?.path != resources.daemon.path {
            guard let build = try? await buildID(resources.daemon, environment: environment),
                  let version = await output(resources.daemon, arguments: ["version"], environment: environment) else { return nil }
            bundledIdentity = (resources.daemon.path, build, version)
        }
        guard let bundledBuild = bundledIdentity?.buildID, let bundledVersion = bundledIdentity?.version,
              let readiness: Readiness = try? await client(connection).request("/api/readiness", timeout: 5),
              let daemon = readiness.daemon, daemon.ready else { return nil }
        // 서비스가 실제로 올라와 있어야 '다시 시작'이 뜻이 있다.
        guard (try? await run(URL(fileURLWithPath: "/bin/launchctl"), arguments: ["print", "gui/\(getuid())/com.iamceo.server"], environment: environment, timeout: 10)) == 0 else { return nil }
        return upgradeOffer(endpoint: endpoint, configuredPort: configuredPort, plist: plist, daemonPath: resources.daemon.path, dataHome: dataHome,
                            defaultHome: defaultHome, running: (buildID: daemon.buildId, version: daemon.version),
                            bundled: (buildID: bundledBuild, version: bundledVersion))
    }

    /// 앱에 든 서버로 서비스를 다시 시작한다(`iamceo service install --restart`). 팀장 세션은 실행 엔진이 쥐고 있어 이어진다.
    /// 바로 앞에서 조건을 다시 확인하고, 그사이 달라졌으면 아무것도 하지 않는다.
    func restartWithBundledServer(endpoint: String, expected: ServerUpgradeOffer) async throws {
        guard !isStarting else { throw LocalHostError("이미 이 Mac의 서버를 준비하고 있습니다.") }
        isStarting = true
        defer { isStarting = false }
        statusText = "서버를 다시 확인하는 중"
        guard let current = await Self.checkServerUpgrade(endpoint: endpoint), current.bundledBuildID == expected.bundledBuildID else {
            throw LocalHostError("서버 상태가 바뀌어 다시 시작하지 않았습니다. 설정에서 다시 확인해 주세요.")
        }
        let environment = ProcessInfo.processInfo.environment
        let resources = try Self.runtimeResources(environment: environment)
        var launchEnvironment = environment
        launchEnvironment["IAMCEO_HOME"] = Self.dataHome(environment: environment).path
        launchEnvironment["IAMCEO_CORE_BIN"] = resources.core.path
        statusText = "서버를 새 버전으로 다시 시작하는 중"
        // service install --restart 는 내리고, 새 설정으로 올리고, 새 build 가 준비될 때까지(최대 30초) 기다린다.
        let status = try await Self.run(resources.daemon, arguments: ["service", "install", "--restart"], environment: launchEnvironment, timeout: 150)
        guard status == 0 else {
            throw LocalHostError("서버를 다시 시작하지 못했습니다(종료 코드 \(status)). 잠시 뒤 다시 시도하거나 ~/.iamceo/logs의 서버 로그를 확인하세요.")
        }
        statusText = "서버를 새 버전으로 다시 시작했습니다"
    }

    /// 실행 파일 한 줄 출력(버전 등). 실패하면 nil.
    private nonisolated static func output(_ executable: URL, arguments: [String], environment: [String: String]) async -> String? {
        await Task.detached { () -> String? in
            let process = Process()
            let pipe = Pipe()
            process.executableURL = executable
            process.arguments = arguments
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return nil }
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)
            defer { timeout.cancel() }
            let data: Data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
            process.waitUntilExit()
            let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard process.terminationStatus == 0, (1...32).contains(text.count), !text.contains("\n") else { return nil }
            return text
        }.value
    }
    #endif

    #if os(macOS)
    /// 준비될 때까지 0.5초 간격으로 확인한다. 점검 한 번이 길어질 수 있어 횟수와 함께 전체 시간도 묶는다. nil 은 시간 안에 준비되지 않았다는 뜻이다.
    private func awaitReady(dataHome: URL, environment: [String: String], expectedBuildID: String, attempts: Int, within limit: Duration) async throws -> LocalHostConnection? {
        let deadline = ContinuousClock.now + limit
        var reused: (connection: LocalHostConnection, client: APIClient)?
        for _ in 0..<attempts {
            guard ContinuousClock.now < deadline else { break }
            try Task.checkCancellation()
            if let connection = try Self.readConnection(dataHome: dataHome, environment: environment) {
                do {
                    let client: APIClient
                    if let reused, reused.connection == connection { client = reused.client }
                    else { client = try Self.client(connection); reused = (connection, client) }
                    let coreAvailable = try await Self.checkHealth(client, expectedBuildID: expectedBuildID, readinessTimeout: 4, bootstrapTimeout: 30)
                    statusText = coreAvailable ? "이 Mac에 연결했습니다" : "이 Mac에 연결했습니다 · core 연결을 확인하세요"
                    return connection
                } catch let error as APIError where error.status == 401 {
                    throw LocalHostError("로컬 서버의 접속 코드가 설정과 다릅니다. 연결 설정을 확인하세요.")
                } catch {
                    // Startup can expose health before its first bootstrap is ready.
                }
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        return nil
    }
    #endif

    private struct Readiness: Decodable, Sendable {
        struct Daemon: Decodable, Sendable { let ready: Bool; let buildId: String; let version: String }
        struct Schema: Decodable, Sendable { let version: Int; let supportedVersion: Int }
        struct Core: Decodable, Sendable { let available: Bool }
        let ok: Bool
        let version: String
        let daemon: Daemon?
        let schema: Schema
        let core: Core?
    }
    private static func client(_ connection: LocalHostConnection) throws -> APIClient {
        APIClient(endpoint: try ServerEndpoint(connection.url.absoluteString), accessCode: connection.accessCode)
    }
    /// 라이브 서버의 bootstrap 은 바쁠 때 십수 초가 걸린다. 그보다 짧게 끊으면 멀쩡한 서버를 '문제'로 읽는다.
    private static func checkHealth(_ client: APIClient, expectedBuildID: String, readinessTimeout: TimeInterval, bootstrapTimeout: TimeInterval) async throws -> Bool {
        let readiness: Readiness = try await client.request("/api/readiness", timeout: readinessTimeout)
        guard readiness.ok, let daemon = readiness.daemon, daemon.ready,
              daemon.buildId == expectedBuildID, daemon.version == readiness.version,
              readiness.schema.version > 0, readiness.schema.version == readiness.schema.supportedVersion else {
            throw LocalHostError("로컬 서버의 준비 상태·실행 build·DB 스키마가 앱과 맞지 않습니다. 설치와 실행 중인 서비스를 확인하세요.")
        }
        let _: Bootstrap = try await client.request("/api/bootstrap", timeout: bootstrapTimeout)
        return readiness.core?.available == true
    }

    #if os(macOS)
    private struct RuntimeResources { let daemon: URL; let core: URL }
    private nonisolated static func buildID(_ executable: URL, environment: [String: String]) async throws -> String {
        try await Task.detached {
            let process = Process()
            let output = Pipe()
            process.executableURL = executable
            process.arguments = ["build-id"]
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)
            defer { timeout.cancel() }
            // readDataToEndOfFile 은 읽기 오류를 잡을 수 없는 NSException 으로 던진다.
            let data = try output.fileHandleForReading.readToEnd() ?? Data()
            process.waitUntilExit()
            let identity = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard process.terminationStatus == 0, identity.count == 64,
                  identity.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
                throw LocalHostError("앱에 포함된 서버의 build ID를 확인하지 못했습니다.")
            }
            return identity
        }.value
    }
    private static func runtimeResources(environment: [String: String]) throws -> RuntimeResources {
        let manager = FileManager.default
        if Bundle.main.bundleURL.pathExtension == "app", let resources = Bundle.main.resourceURL {
            let runtime = resources.appendingPathComponent("runtime", isDirectory: true)
            let daemon = runtime.appendingPathComponent("iamceo")
            let core = runtime.appendingPathComponent("Herdr Core.app/Contents/MacOS/herdr-core")
            if manager.isExecutableFile(atPath: daemon.path), manager.isExecutableFile(atPath: core.path) {
                return RuntimeResources(daemon: daemon, core: core)
            }
        }
        // Source/SwiftPM QA is opt-in and never searches or installs a global executable.
        if let daemonPath = environment["IAMCEO_DAEMON_BIN"], daemonPath.hasPrefix("/"),
           let corePath = environment["IAMCEO_CORE_BIN"], corePath.hasPrefix("/"),
           manager.isExecutableFile(atPath: daemonPath), manager.isExecutableFile(atPath: corePath) {
            return RuntimeResources(daemon: URL(fileURLWithPath: daemonPath), core: URL(fileURLWithPath: corePath))
        }
        throw LocalHostError("실행 파일이 포함된 IAMCEO.app이 필요합니다. 소스 개발 환경에서는 bun run build:native로 앱을 만들거나, QA용 IAMCEO_DAEMON_BIN과 IAMCEO_CORE_BIN에 실행 파일의 절대 경로를 지정하세요.")
    }

    private struct LocalConfig: Decodable { let accessCode: String; let port: Int? }
    private static func dataHome(environment: [String: String]) -> URL {
        if let path = environment["IAMCEO_HOME"], !path.isEmpty { return URL(fileURLWithPath: path).standardizedFileURL }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".iamceo", isDirectory: true)
    }
    private static func port(environment: [String: String], configured: Int?) throws -> Int {
        let value: Int
        if let raw = environment["IAMCEO_PORT"], !raw.isEmpty {
            guard let parsed = Int(raw) else { throw LocalHostError("로컬 서버 포트 설정을 확인하세요.") }
            value = parsed
        } else { value = configured ?? 7878 }
        guard (1...65535).contains(value) else { throw LocalHostError("로컬 서버 포트 설정을 확인하세요.") }
        return value
    }
    private static func readConnection(dataHome: URL, environment: [String: String]) throws -> LocalHostConnection? {
        let configURL = dataHome.appendingPathComponent("config.json")
        guard FileManager.default.fileExists(atPath: configURL.path) else { return nil }
        let config: LocalConfig
        do { config = try JSONDecoder().decode(LocalConfig.self, from: Data(contentsOf: configURL)) }
        catch { throw LocalHostError("IAMCEO 로컬 설정을 읽지 못했습니다. 기존 config.json을 확인하세요.") }
        guard !config.accessCode.isEmpty else { throw LocalHostError("IAMCEO 로컬 설정에 접속 코드가 없습니다.") }
        let configuredPort = try port(environment: environment, configured: config.port)
        return LocalHostConnection(url: URL(string: "http://127.0.0.1:\(configuredPort)")!, accessCode: config.accessCode)
    }
    private static func requireUnusedPort(_ port: Int) async throws {
        // No credential is sent when no IAMCEO config exists. Any listener is left alone.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 2
        let session = URLSession(configuration: configuration, delegate: LocalProbeRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!)
        request.timeoutInterval = 2
        do { let _ = try await session.data(for: request) }
        catch let error as URLError where error.code == .cannotConnectToHost { return }
        catch { throw LocalHostError("로컬 포트 \(port)의 상태를 확인하지 못했습니다. 기존 프로그램은 변경하지 않았습니다.") }
        throw LocalHostError("다른 프로그램이 로컬 포트 \(port)를 사용 중입니다. 기존 프로그램을 바꾸지 않았습니다.")
    }
    private static func requireOwnedPlist(daemon: URL, dataHome: URL) throws {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.iamceo.server.plist")
        guard FileManager.default.fileExists(atPath: path.path) else { return }
        let data = try Data(contentsOf: path)
        let object = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        let environment = object?["EnvironmentVariables"] as? [String: String]
        let ownerHome = environment?["IAMCEO_HOME"].map { URL(fileURLWithPath: $0).standardizedFileURL } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".iamceo")
        guard object?["Label"] as? String == "com.iamceo.server", object?["ProgramArguments"] as? [String] == [daemon.path, "serve"], ownerHome == dataHome else {
            throw LocalHostError("다른 설치의 서비스 설정이 있어 자동 교체하지 않았습니다. 기존 IAMCEO 설치의 서비스 설정을 확인하세요.")
        }
    }
    /// No shell, no command output, and no access code in logs or arguments.
    nonisolated static func run(_ executable: URL, arguments: [String], environment: [String: String], timeout: TimeInterval) async throws -> Int32 {
        let child = ChildRun()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                child.start(executable, arguments: arguments, environment: environment, timeout: timeout, continuation: continuation)
            }
        } onCancel: { child.stop(CancellationError()) }
    }
    #endif
}

#if os(macOS)
/// 자식 프로세스 대기를 한 번만 끝낸다: 정상 종료, 제한 시간, 취소 가운데 먼저 온 쪽이 이긴다.
private final class ChildRun: @unchecked Sendable {
    private let lock = NSLock()
    private let process = Process()
    private var continuation: CheckedContinuation<Int32, any Error>?
    private var result: Result<Int32, any Error>?
    private var launched = false

    func start(_ executable: URL, arguments: [String], environment: [String: String], timeout: TimeInterval,
               continuation: CheckedContinuation<Int32, any Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return } // 시작 전에 취소됨
        self.continuation = continuation
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] completed in self?.finish(.success(completed.terminationStatus), terminate: false) }
        // 실행까지 잠금 안에서 끝내 취소가 '띄우기 직전'에 끼어들지 못하게 한다.
        do { try process.run(); launched = true; lock.unlock() }
        catch {
            lock.unlock()
            finish(.failure(LocalHostError("로컬 실행 서비스를 시작할 수 없습니다. 앱의 실행 파일과 macOS 권한을 확인하세요.")), terminate: false)
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.stop(LocalHostError("이 Mac의 실행 서비스 준비가 제한 시간 안에 끝나지 않았습니다. 잠시 뒤 다시 시도하세요."))
        }
    }
    func stop(_ error: any Error) { finish(.failure(error), terminate: true) }
    private func finish(_ value: Result<Int32, any Error>, terminate: Bool) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let waiting = continuation
        continuation = nil
        let running = launched
        lock.unlock()
        if terminate, running, process.isRunning { process.terminate() }
        waiting?.resume(with: value)
    }
}
#endif

private struct LocalHostError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

#if os(macOS)
private final class LocalProbeRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
#endif
