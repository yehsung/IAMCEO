import Foundation
import Observation

struct LocalHostConnection: Sendable {
    let url: URL
    let accessCode: String
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
        statusText = "기존 로컬 연결을 확인하는 중"
        if let current = try Self.readConnection(dataHome: dataHome, environment: environment) {
            do {
                try await Self.checkHealth(current)
                statusText = "이 Mac에 연결했습니다"
                return current
            } catch let error as URLError where error.code == .cannotConnectToHost {
                // Only a refused connection means it is safe to attempt a new local host.
            } catch {
                throw LocalHostError("기존 로컬 서버에 응답 또는 인증 문제가 있습니다. 실행 중인 서비스를 바꾸지 않았습니다. 연결 설정을 확인하세요.")
            }
        } else {
            try await Self.requireUnusedPort(Self.port(environment: environment, configured: nil))
        }
        let resources = try Self.runtimeResources(environment: environment)
        let target = "gui/\(getuid())/com.iamceo.server"
        if try await Self.run(URL(fileURLWithPath: "/bin/launchctl"), arguments: ["print", target], environment: environment) == 0 {
            throw LocalHostError("이미 등록된 IAMCEO 서비스가 있습니다. 기존 서비스의 연결 문제를 먼저 확인하세요. 실행 중인 서비스는 교체하지 않았습니다.")
        }
        try Self.requireOwnedPlist(daemon: resources.daemon, dataHome: dataHome)
        var launchEnvironment = environment
        launchEnvironment["IAMCEO_HOME"] = dataHome.path
        launchEnvironment["IAMCEO_CORE_BIN"] = resources.core.path
        statusText = "이 Mac의 실행 서비스를 준비하는 중"
        let status = try await Self.run(resources.daemon, arguments: ["service", "install"], environment: launchEnvironment)
        guard status == 0 else {
            throw LocalHostError("로컬 서비스 등록을 완료하지 못했습니다 (종료 코드 \(status)). 기존 설치의 서비스 설정을 확인하세요.")
        }
        statusText = "서버가 준비되기를 기다리는 중"
        for _ in 0..<60 {
            try Task.checkCancellation()
            if let connection = try Self.readConnection(dataHome: dataHome, environment: environment) {
                do {
                    try await Self.checkHealth(connection)
                    statusText = "이 Mac에 연결했습니다"
                    return connection
                } catch let error as APIError where error.status == 401 {
                    throw LocalHostError("로컬 서버의 접속 코드가 설정과 다릅니다. 연결 설정을 확인하세요.")
                } catch {
                    // Startup can expose health before its first bootstrap is ready.
                }
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw LocalHostError("로컬 서버가 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하거나 ~/.iamceo/logs의 서버 로그를 확인하세요.")
        #else
        throw LocalHostError("로컬 실행은 Mac 앱에서 시작할 수 있습니다. iPhone에서는 실행 중인 Mac에 연결하세요.")
        #endif
    }

    private struct Health: Decodable, Sendable { let ok: Bool; let version: String }
    private static func checkHealth(_ connection: LocalHostConnection) async throws {
        let client = APIClient(endpoint: try ServerEndpoint(connection.url.absoluteString), accessCode: connection.accessCode)
        let health: Health = try await client.request("/api/health", timeout: 2)
        guard health.ok, !health.version.isEmpty else { throw LocalHostError("로컬 서버 응답을 확인할 수 없습니다.") }
        let _: Bootstrap = try await client.request("/api/bootstrap", timeout: 3)
    }

    #if os(macOS)
    private struct RuntimeResources { let daemon: URL; let core: URL }
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
    private nonisolated static func run(_ executable: URL, arguments: [String], environment: [String: String]) async throws -> Int32 {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { completed in continuation.resume(returning: completed.terminationStatus) }
            do { try process.run() }
            catch { continuation.resume(throwing: LocalHostError("로컬 실행 서비스를 시작할 수 없습니다. 앱의 실행 파일과 macOS 권한을 확인하세요.")) }
        }
    }
    #endif
}

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
