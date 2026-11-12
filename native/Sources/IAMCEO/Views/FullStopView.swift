import SwiftUI
import Observation

#if os(macOS)
/// B 묶음: 설정 › 연결의 '이 Mac에서 완전히 멈추기'. 앱에 들어 있는 서버 실행 파일의 `iamceo uninstall` 을 그대로 부른다.
/// 순서(서버가 정한다): 팀장 재우기 → 로그인 서비스 해제 → 실행 엔진의 터미널 종료·엔진 종료. 데이터는 남긴다.
/// 데이터 지우기(`--purge`)는 멈춘 뒤에만 보이는 줄에서 따로 한 번 더 확인한다.
/// 이 앱이 관리하는 서비스(등록된 서비스가 없거나, [이 앱의 runtime/iamceo, serve] 로 같은 데이터 폴더를 쓰는 것)일 때만 보인다.
/// 소스 체크아웃이나 옛 명령줄 설치의 서비스는 이 앱이 내리지 않는다(LocalHostService 의 판정과 같다).
@MainActor @Observable
final class FullStopRunner {
    enum Busy: Equatable { case stop, purge }
    private(set) var busy: Busy?
    private(set) var stopped = false
    private(set) var purged = false
    private(set) var message: String?
    private(set) var failed = false

    /// 앱 묶음 안의 서버 실행 파일. 소스로 돌리는 QA 는 IAMCEO_DAEMON_BIN 으로 지정한다(LocalHostService 와 같은 규칙).
    nonisolated static func daemon(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        let manager = FileManager.default
        if Bundle.main.bundleURL.pathExtension == "app", let resources = Bundle.main.resourceURL {
            let daemon = resources.appendingPathComponent("runtime/iamceo")
            if manager.isExecutableFile(atPath: daemon.path) { return daemon }
        }
        if let path = environment["IAMCEO_DAEMON_BIN"], path.hasPrefix("/"), manager.isExecutableFile(atPath: path) { return URL(fileURLWithPath: path) }
        return nil
    }
    nonisolated static var available: Bool { daemon() != nil }

    /// 앱 묶음 안의 실행 엔진(LocalHostService.runtimeResources 와 같은 자리). 서비스 설정이 이미 없어도 엔진을 끌 수 있게 넘긴다.
    nonisolated static func core(beside daemon: URL) -> URL? {
        let core = daemon.deletingLastPathComponent().appendingPathComponent("Herdr Core.app/Contents/MacOS/herdr-core")
        return FileManager.default.isExecutableFile(atPath: core.path) ? core : nil
    }

    /// 멈추기에 넘길 환경: 명령줄 문구는 한국어, 실행 엔진 자리는 앱 안의 것(이미 정해져 있으면 그대로).
    nonisolated static func childEnvironment(_ base: [String: String], daemon: URL) -> [String: String] {
        var environment = base
        environment["IAMCEO_LANG"] = "ko"
        if environment["IAMCEO_CORE_BIN"]?.isEmpty ?? true, let core = core(beside: daemon) { environment["IAMCEO_CORE_BIN"] = core.path }
        return environment
    }

    /// 등록된 서비스가 이 앱이 멈춰도 되는 것인가. 없으면 그렇다(멈출 서비스가 없다). 있으면 이 앱의 실행 파일을 serve 로 돌리고 같은 데이터 폴더를 써야 한다.
    nonisolated static func ownsRegisteredService(plist: [String: Any]?, daemonPath: String, dataHome: URL, defaultHome: URL) -> Bool {
        guard let plist else { return true }
        guard plist["Label"] as? String == "com.iamceo.server", plist["ProgramArguments"] as? [String] == [daemonPath, "serve"] else { return false }
        let environment = plist["EnvironmentVariables"] as? [String: String]
        let ownerHome = environment?["IAMCEO_HOME"].map { URL(fileURLWithPath: $0).standardizedFileURL } ?? defaultHome.standardizedFileURL
        return ownerHome.path == dataHome.standardizedFileURL.path
    }

    /// 이 Mac 에 등록된 서비스 설정. 파일이 없으면 nil, 있는데 읽지 못하면 빈 사전(이 앱의 것이 아니다).
    nonisolated static func registeredService() -> [String: Any]? {
        let url = LocalHostService.servicePlistURL
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url),
              let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] else { return [:] }
        return plist
    }

    /// 지금 이 Mac 에서 '완전히 멈추기'를 보여도 되는가(앱 실행 파일이 있고, 등록된 서비스가 이 앱의 것이거나 없다).
    nonisolated static func offered(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        guard let daemon = daemon(environment: environment) else { return false }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaultHome = home.appendingPathComponent(".iamceo", isDirectory: true)
        let dataHome = environment["IAMCEO_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? defaultHome
        return ownsRegisteredService(plist: registeredService(), daemonPath: daemon.path, dataHome: dataHome, defaultHome: defaultHome)
    }

    /// 멈춘 뒤의 안내. '이 Mac에서 시작'으로 다시 켤 수 있다는 말은 이 앱의 서비스를 지웠을 때만 한다.
    nonisolated static func stoppedMessage(removedAppService: Bool) -> String {
        removedAppService
            ? "모두 멈췄습니다. 대화와 자료는 그대로 남아 있고, ‘이 Mac에서 시작’으로 다시 켤 수 있습니다. 앱을 지우려면 응용 프로그램 폴더의 IAMCEO를 휴지통으로 옮기세요."
            : "모두 멈췄습니다. 대화와 자료는 그대로 남아 있습니다. 앱을 지우려면 응용 프로그램 폴더의 IAMCEO를 휴지통으로 옮기세요."
    }

    /// 명령줄 인자. 앱에서 이미 확인했으므로 --yes 로 묻지 않게 한다.
    nonisolated static func arguments(purge: Bool) -> [String] { purge ? ["uninstall", "--purge", "--yes"] : ["uninstall", "--yes"] }

    func stop() async {
        guard busy == nil else { return }
        busy = .stop; message = nil; failed = false
        defer { busy = nil }
        // 줄을 보인 뒤에 서비스가 바뀌었을 수 있다. 누른 순간 다시 보고, 이 앱의 것이 아니면 아무것도 하지 않는다.
        guard Self.daemon() == nil || Self.offered() else {
            failed = true
            message = "이 앱이 등록하지 않은 IAMCEO 서비스(소스에서 도는 서버나 옛 설치)가 있어 멈추지 않았습니다. 그 서버는 그 설치의 방법으로 멈추세요."
            return
        }
        let removedAppService = Self.registeredService() != nil
        let result = await Self.run(Self.arguments(purge: false))
        if result.status == 0 {
            stopped = true
            message = Self.stoppedMessage(removedAppService: removedAppService)
        } else {
            failed = true
            message = result.reason ?? "완전히 멈추지 못했습니다(종료 코드 \(result.status)). 잠시 뒤 다시 해 보세요."
        }
    }

    func purge() async -> Bool {
        guard busy == nil, stopped else { return false }
        busy = .purge; message = nil; failed = false
        defer { busy = nil }
        let result = await Self.run(Self.arguments(purge: true))
        if result.status == 0 {
            purged = true
            message = "이 Mac의 IAMCEO 데이터를 지웠습니다."
            return true
        }
        failed = true
        message = result.reason ?? "데이터를 지우지 못했습니다(종료 코드 \(result.status))."
        return false
    }

    /// 명령줄의 마지막 오류 줄을 사람에게 보일 까닭으로 쓴다(명령줄 오류는 사람이 읽는 한 문장이다).
    private nonisolated static func run(_ arguments: [String]) async -> (status: Int32, reason: String?) {
        guard let daemon = daemon() else { return (-1, "실행 파일이 들어 있는 IAMCEO 앱에서만 할 수 있습니다.") }
        let childEnvironment = Self.childEnvironment(ProcessInfo.processInfo.environment, daemon: daemon)
        return await Task.detached { () -> (status: Int32, reason: String?) in
            let process = Process()
            let output = Pipe()
            process.executableURL = daemon
            process.arguments = arguments
            process.environment = childEnvironment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = output
            do { try process.run() } catch { return (-1, "멈추기 명령을 실행하지 못했습니다. 앱을 다시 설치해 보세요.") }
            // 팀장이 많으면 재우기에 몇 분 걸릴 수 있다. 그보다 길면 끊는다.
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 600, execute: timeout)
            defer { timeout.cancel() }
            // readDataToEndOfFile 은 읽기 오류를 잡을 수 없는 예외로 던진다.
            let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
            process.waitUntilExit()
            let status = process.terminationStatus
            return (status, status == 0 ? nil : FullStopRunner.lastLine(data))
        }.value
    }

    nonisolated static func lastLine(_ data: Data) -> String? {
        (String(data: data, encoding: .utf8) ?? "").split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.last
    }
}

/// 설정 › 연결 아래의 한 묶음. SettingsGroup·SettingsRow 를 그대로 쓴다.
struct FullStopGroup: View {
    @Environment(AppStore.self) private var store
    /// 데이터를 지운 뒤 이 기기의 저장된 연결도 정리한다(설정의 '나가기'와 같은 동작). 이 Mac 의 서버에 붙어 있을 때만 부른다.
    let onDataDeleted: () -> Void
    @State private var runner = FullStopRunner()
    @State private var confirmStop = false
    @State private var confirmPurge = false

    /// 다른 Mac 의 서버에 붙어 있어도 멈추기·지우기는 이 Mac 의 IAMCEO 만 다룬다. 그 서버와의 연결은 그대로 둔다.
    nonisolated static func leavesConnection(afterPurgeOnThisMac serverIsThisMac: Bool) -> Bool { serverIsThisMac }
    nonisolated static func stopHint(serverIsThisMac: Bool) -> String {
        serverIsThisMac ? "모든 팀장과 실행 엔진을 끄고 로그인할 때 저절로 켜지지 않게 합니다. 데이터는 남습니다"
            : "이 Mac의 IAMCEO만 멈춥니다. 지금 연결한 다른 Mac의 서버는 그대로입니다. 데이터는 남습니다"
    }
    nonisolated static func purgeHint(serverIsThisMac: Bool) -> String {
        serverIsThisMac ? "대화·결재·자료·첨부와 백업을 이 Mac에서 지웁니다. 되돌릴 수 없습니다"
            : "이 Mac의 데이터만 지웁니다. 지금 연결한 다른 Mac의 서버와 데이터는 그대로입니다. 되돌릴 수 없습니다"
    }

    var body: some View {
        // 이 앱이 관리하지 않는 서비스(소스에서 도는 서버, 옛 설치)가 등록돼 있으면 줄을 보이지 않는다. 멈춘 뒤에는 '데이터도 지우기'를 위해 남긴다.
        if runner.stopped || FullStopRunner.offered() { group }
    }

    private var group: some View {
        SettingsGroup(footnote: runner.message, footnoteTone: runner.failed ? CE.danger : CE.ink2) {
            SettingsRow("이 Mac에서 완전히 멈추기", hint: Self.stopHint(serverIsThisMac: store.serverIsThisMac)) {
                Button { confirmStop = true } label: {
                    HStack(spacing: 6) {
                        if runner.busy == .stop { ProgressView().controlSize(.small) }
                        Text(runner.busy == .stop ? "멈추는 중" : "멈추기").foregroundStyle(store.isDemo ? CE.ink3 : CE.danger)
                    }
                }
                .ceSecondaryButton()
                .ceCompactControl()
                .fixedSize()
                .disabled(store.isDemo || runner.busy != nil || runner.purged)
            }
            if runner.stopped && !runner.purged {
                RowDivider(inset: 0)
                SettingsRow("데이터도 지우기", hint: Self.purgeHint(serverIsThisMac: store.serverIsThisMac)) {
                    Button { confirmPurge = true } label: {
                        HStack(spacing: 6) {
                            if runner.busy == .purge { ProgressView().controlSize(.small) }
                            Text(runner.busy == .purge ? "지우는 중" : "지우기").foregroundStyle(CE.danger)
                        }
                    }
                    .ceSecondaryButton()
                    .ceCompactControl()
                    .fixedSize()
                    .disabled(runner.busy != nil)
                }
            }
        }
        .confirmationDialog("이 Mac에서 IAMCEO를 완전히 멈출까요?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("멈추기", role: .destructive) { Task { await runner.stop() } }
            Button("취소", role: .cancel) {}
        } message: {
            Text("일하던 팀장의 세션까지 모두 끝내고 실행 엔진을 끈 뒤, 로그인할 때 서버가 저절로 켜지지 않게 합니다. 대화와 자료는 그대로 남고 나중에 ‘이 Mac에서 시작’으로 다시 켤 수 있습니다.")
        }
        .confirmationDialog("이 Mac의 IAMCEO 데이터를 모두 지울까요?", isPresented: $confirmPurge, titleVisibility: .visible) {
            Button("모두 지우기", role: .destructive) {
                Task { if await runner.purge(), Self.leavesConnection(afterPurgeOnThisMac: store.serverIsThisMac) { onDataDeleted() } }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("대화·결재·업무·자료·첨부와 매일 만든 백업까지 사라지고 되돌릴 수 없습니다. 남길 프로젝트가 있으면 먼저 보관함에서 내보내 두세요.")
        }
    }
}
#endif
