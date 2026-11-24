import Foundation
import Observation

// 0.2.11: AI 도구(CLI) 새 판 알림과 원클릭 업데이트(서버 server/cli-update.ts).
// - 서버는 Bootstrap 의 선택 칸 cliUpdates 에 설치된 CLI 마다 지금 판·최신 판·진행을 싣고, 진행이 바뀌면 projects 사건으로 다시 읽게 한다.
// - GET /api/cli-updates[?refresh=1] 은 같은 목록(refresh=1 이면 최신 판을 다시 읽는다), POST /api/cli-updates/:cli { to } 는 업데이트를 시작한다(202).
// - 옛 서버는 칸이 없고 경로가 404 다: 앱은 아무것도 더 그리지 않는다.
// 서버가 모르는 값(설치 방식·진행 단계)을 보내도 버리지 않고 글자 그대로 읽는다.

/// 업데이트가 실패한 까닭(서버 ERROR_CODES 의 코드와 문장).
struct CLIUpdateFailure: Codable, Sendable, Equatable {
    var code: String
    var message: String
}

/// 대표가 누른 업데이트 한 번(서버는 CLI 마다 마지막 한 번만 기억한다).
struct CLIUpdateRun: Codable, Sendable, Equatable {
    var id: String
    var cli: String
    var from: String? = nil
    var to: String? = nil
    /// downloading · installing · verifying · done · failed. 모르는 값도 그대로 둔다.
    var phase: String
    var startedAt: String = ""
    var endedAt: String? = nil
    var installed: String? = nil
    var error: CLIUpdateFailure? = nil
    var manualCommand: String? = nil

    enum CodingKeys: String, CodingKey { case id, cli, from, to, phase, startedAt, endedAt, installed, error, manualCommand }

    init(id: String, cli: String, from: String? = nil, to: String? = nil, phase: String, startedAt: String = "", endedAt: String? = nil,
         installed: String? = nil, error: CLIUpdateFailure? = nil, manualCommand: String? = nil) {
        self.id = id; self.cli = cli; self.from = from; self.to = to; self.phase = phase; self.startedAt = startedAt
        self.endedAt = endedAt; self.installed = installed; self.error = error; self.manualCommand = manualCommand
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        cli = try c.decode(String.self, forKey: .cli)
        phase = try c.decode(String.self, forKey: .phase)
        from = c.lenient(String.self, forKey: .from)
        to = c.lenient(String.self, forKey: .to)
        startedAt = c.lenient(String.self, forKey: .startedAt) ?? ""
        endedAt = c.lenient(String.self, forKey: .endedAt)
        installed = c.lenient(String.self, forKey: .installed)
        error = c.lenient(CLIUpdateFailure.self, forKey: .error)
        manualCommand = c.lenient(String.self, forKey: .manualCommand)
    }

    /// 아직 도는 중(내려받는 중·설치 중·확인 중). 모르는 단계는 도는 중으로 보지 않는다(돌림표가 영영 남지 않게).
    var active: Bool { ["downloading", "installing", "verifying"].contains(phase) }
    var succeeded: Bool { phase == "done" }
    var failed: Bool { phase == "failed" }

    /// 진행 단계의 순서. 같은 업데이트의 두 소식 가운데 더 나아간 것을 고를 때 쓴다.
    var rank: Int {
        switch phase {
        case "downloading": 1
        case "installing": 2
        case "verifying": 3
        case "done", "failed": 4
        default: 0
        }
    }
}

/// 서버가 쓰는 CLI 하나의 지금 판·최신 판·업데이트 상태.
struct CLIUpdateInfo: Codable, Sendable, Equatable, Identifiable {
    var cli: String
    var current: String? = nil
    var latest: String? = nil
    var available: Bool = false
    var latestVerified: Bool = false
    /// brew_cask · brew_formula · npm_global · claude_native · agy_self · unknown. 모르는 값도 그대로 둔다.
    var method: String = "unknown"
    var oneClick: Bool = false
    var manualCommand: String? = nil
    var source: String? = nil
    var checkedAt: String? = nil
    var run: CLIUpdateRun? = nil
    var liveSessions: Int? = nil
    var pendingReopen: Int? = nil
    var id: String { cli }

    enum CodingKeys: String, CodingKey {
        case cli, current, latest, available, latestVerified, method, oneClick, manualCommand, source, checkedAt, run, liveSessions, pendingReopen
    }

    init(cli: String, current: String? = nil, latest: String? = nil, available: Bool = false, latestVerified: Bool = false, method: String = "unknown",
         oneClick: Bool = false, manualCommand: String? = nil, source: String? = nil, checkedAt: String? = nil, run: CLIUpdateRun? = nil,
         liveSessions: Int? = nil, pendingReopen: Int? = nil) {
        self.cli = cli; self.current = current; self.latest = latest; self.available = available; self.latestVerified = latestVerified
        self.method = method; self.oneClick = oneClick; self.manualCommand = manualCommand; self.source = source; self.checkedAt = checkedAt
        self.run = run; self.liveSessions = liveSessions; self.pendingReopen = pendingReopen
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cli = try c.decode(String.self, forKey: .cli)
        current = c.lenient(String.self, forKey: .current)
        latest = c.lenient(String.self, forKey: .latest)
        available = c.lenient(Bool.self, forKey: .available) ?? false
        latestVerified = c.lenient(Bool.self, forKey: .latestVerified) ?? false
        method = c.lenient(String.self, forKey: .method) ?? "unknown"
        oneClick = c.lenient(Bool.self, forKey: .oneClick) ?? false
        manualCommand = c.lenient(String.self, forKey: .manualCommand)
        source = c.lenient(String.self, forKey: .source)
        checkedAt = c.lenient(String.self, forKey: .checkedAt)
        run = c.lenient(CLIUpdateRun.self, forKey: .run)
        liveSessions = c.lenient(Int.self, forKey: .liveSessions)
        pendingReopen = c.lenient(Int.self, forKey: .pendingReopen)
    }

    /// 대표에게 알릴 새 판이 있다(이 앱이 아는 CLI 이고, 그 판으로 올리는 중이거나 이미 올린 것이 아니다).
    var announces: Bool {
        guard available, let latest, !latest.isEmpty, RankSettingsCLI(cli: cli) != nil else { return false }
        if let run, run.to == latest, run.active || run.succeeded { return false }
        return true
    }
    /// '업데이트' 단추를 보일 때: 새 판이 있고, 서버가 그 방식을 돌릴 수 있고, 도는 업데이트가 없다.
    var canStart: Bool { available && oneClick && latest != nil && run?.active != true }
}

struct CLIUpdatesResponse: Decodable, Sendable {
    var updates: [CLIUpdateInfo]
}

extension APIClient {
    func cliUpdates(refresh: Bool = false) async throws -> CLIUpdatesResponse {
        // 최신 판을 다시 읽는 요청은 몇 초 걸릴 수 있다.
        try await request("/api/cli-updates" + (refresh ? "?refresh=1" : ""), timeout: 30)
    }
    func startCLIUpdate(cli: String, to: String?) async throws -> CLIUpdateRun {
        struct Body: Encodable, Sendable { let to: String? }
        return try await send("/api/cli-updates/\(Self.segment(cli))", body: Body(to: to))
    }
}

// MARK: - Text

enum CLIUpdateText {
    /// CLI 이름(서버 CLI_INFO 와 같다): Claude Code · Codex · Antigravity CLI.
    static func name(_ cli: String) -> String { CLIAccountText.name(cli) }

    /// 판 뒤의 조사(로/으로). 숫자는 한국어로 읽은 끝소리를 따른다: 0(영)·3(삼)·6(육)은 받침이 있어 '으로', 1(일)·7(칠)·8(팔)은 ㄹ이라 '로'.
    static func takesEuro(_ version: String) -> Bool {
        guard let last = version.unicodeScalars.last(where: { CharacterSet.alphanumerics.contains($0) }) else { return false }
        return ["0", "3", "6"].contains(Character(last))
    }

    /// 'Claude Code 2.1.332' 묶음(여럿이면 ' · ' 로 잇는다).
    static func versions(_ updates: [CLIUpdateInfo]) -> String {
        updates.compactMap { info in info.latest.map { "\(name(info.cli)) \($0)" } }.joined(separator: " · ")
    }

    /// 상태 띠·Mac 알림 제목. 'Claude Code 2.1.332 업데이트가 있습니다'.
    static func available(_ updates: [CLIUpdateInfo]) -> String {
        let list = versions(updates)
        return String(localized: "\(list) 업데이트가 있습니다")
    }

    /// 상태 띠의 단추: 새 판이 하나이고 서버가 올릴 수 있으면 그 CLI('업데이트' → 확인 창까지), 아니면 nil('보기').
    static func oneClickTarget(_ fresh: [CLIUpdateInfo]) -> CLIUpdateInfo? {
        fresh.count == 1 && fresh[0].canStart ? fresh[0] : nil
    }

    static var macNotificationBody: String { String(localized: "설정 › AI 모델 › 실행 환경에서 업데이트할 수 있습니다.") }

    /// 점검표 줄의 새 판 한 줄. 확인한 판인지 함께 적는다.
    static func newVersion(_ info: CLIUpdateInfo) -> String {
        let latest = info.latest ?? ""
        return info.latestVerified ? String(localized: "새 판 \(latest) · IAMCEO가 확인한 판")
                                   : String(localized: "새 판 \(latest) · 아직 IAMCEO가 확인하지 않은 판")
    }

    /// 서버가 업데이트를 돌릴 수 없는 설치. 직접 할 명령이 있으면 그것을 보인다.
    static func manual(_ info: CLIUpdateInfo) -> String {
        if let command = info.manualCommand, !command.isEmpty { return String(localized: "이 Mac의 터미널에서 직접 업데이트하세요: \(command)") }
        return String(localized: "이 설치 방식은 IAMCEO가 업데이트하지 못합니다. 깐 방법으로 직접 업데이트하세요.")
    }

    /// 도는 업데이트의 단계.
    static func phase(_ run: CLIUpdateRun) -> String {
        switch run.phase {
        case "downloading": String(localized: "내려받는 중…")
        case "installing": String(localized: "설치 중…")
        case "verifying": String(localized: "새 판을 확인하는 중…")
        default: String(localized: "업데이트하는 중…")
        }
    }

    /// 끝난 업데이트. '2.1.332로 올렸습니다' + 다시 열기를 기다리는 팀장이 있으면 '적용 중: N명 남음'.
    static func done(_ run: CLIUpdateRun, pendingReopen: Int?) -> String {
        let version = run.installed ?? run.to ?? ""
        let head = takesEuro(version) ? String(localized: "\(version)으로 올렸습니다") : String(localized: "\(version)로 올렸습니다")
        guard let pending = pendingReopen, pending > 0 else { return head }
        return head + " · " + pendingText(pending)
    }

    static func pendingText(_ count: Int) -> String { String(localized: "적용 중: \(count)명 남음") }

    static func failure(_ run: CLIUpdateRun) -> String {
        guard let error = run.error else { return String(localized: "업데이트하지 못했습니다. 옛 판이 그대로 남아 있습니다.") }
        return ServerErrorText.display(error.message, code: error.code)
    }

    static func manualCommand(_ command: String) -> String { String(localized: "직접 할 명령: \(command)") }

    // 확인 창
    static func confirmTitle(_ info: CLIUpdateInfo) -> String {
        let from = info.current ?? String(localized: "지금 판")
        let to = info.latest ?? ""
        return "\(name(info.cli)) \(from) → \(to)"
    }

    static func confirmMessage(_ info: CLIUpdateInfo) -> String {
        var lines: [String] = []
        lines.append(info.latestVerified ? String(localized: "IAMCEO가 화면 견본으로 확인한 판입니다.")
                                         : String(localized: "아직 IAMCEO가 확인하지 않은 판이라 화면 판독이 어긋날 수 있습니다."))
        if let live = info.liveSessions, live > 0 {
            lines.append(String(localized: "떠 있는 총괄·팀장 \(live)명은 쉬는 때에 같은 대화로 다시 열려 새 판을 씁니다(일하는 중이면 그 턴이 끝난 뒤)."))
        }
        if let command = info.manualCommand, !command.isEmpty { lines.append(String(localized: "서버가 있는 Mac에서 실행할 명령: \(command)")) }
        lines.append(String(localized: "실패하면 옛 판이 그대로 남습니다."))
        return lines.joined(separator: "\n")
    }
}

// MARK: - Merge

enum CLIUpdateMerge {
    /// 같은 업데이트의 두 소식 가운데 더 나아간 것, 다른 업데이트면 나중에 시작한 것.
    static func newer(_ a: CLIUpdateRun?, _ b: CLIUpdateRun?) -> CLIUpdateRun? {
        guard let b else { return a }
        guard let a else { return b }
        if a.id != b.id { return b.startedAt > a.startedAt ? b : a }
        return b.rank > a.rank ? b : a
    }

    /// 이 기기가 따로 읽은 값(local: 시작 응답·다시 확인·진행 읽기)이 서버 스냅샷보다 새로우면 그것을 쓴다.
    static func shown(server: CLIUpdateInfo?, local: CLIUpdateInfo?) -> CLIUpdateInfo? {
        guard let local else { return server }
        guard var server else { return local }
        let run = newer(server.run, local.run)
        // 서버 스냅샷이 이 기기가 막 시작한 업데이트를 아직 모르면, 이 기기 값(그 업데이트가 실린 것)을 쓴다.
        if let mine = local.run, run == mine, server.run != mine { return local }
        server.run = run
        return server
    }

    /// 서버 스냅샷이 바뀌었을 때 이 기기 값을 지울지: 이 기기 값에 서버가 모르는 업데이트가 없으면 지운다.
    static func serverCaughtUp(server: CLIUpdateInfo?, local: CLIUpdateInfo) -> Bool {
        guard let mine = local.run else { return true }
        guard let theirs = server?.run else { return false }
        return theirs.id == mine.id ? theirs.rank >= mine.rank : theirs.startedAt >= mine.startedAt
    }
}

// MARK: - Seen (이 기기에서 본 새 판)

/// 상태 띠의 '보기'를 누른 판. 서버·CLI·판마다 한 번 보면 다시 띄우지 않는다. 저장소를 못 쓰면 이번 실행 동안만 기억한다.
@MainActor @Observable final class CLIUpdateSeen {
    static let shared = CLIUpdateSeen()
    private static let key = "iamceo.cliUpdates.seen.v1"
    private static let limit = 200
    private(set) var keys: [String]
    @ObservationIgnored private let defaults: UserDefaults?

    init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        keys = (defaults?.stringArray(forKey: Self.key)) ?? []
    }

    static func key(server: String, info: CLIUpdateInfo) -> String { "\(server)|\(info.cli)|\(info.latest ?? "")" }

    func contains(server: String, info: CLIUpdateInfo) -> Bool { keys.contains(Self.key(server: server, info: info)) }

    func markSeen(server: String, _ updates: [CLIUpdateInfo]) {
        let added = updates.map { Self.key(server: server, info: $0) }.filter { !keys.contains($0) }
        guard !added.isEmpty else { return }
        keys.append(contentsOf: added)
        if keys.count > Self.limit { keys.removeFirst(keys.count - Self.limit) }
        defaults?.set(keys, forKey: Self.key)
    }

    /// 띠에 보일 새 판들(이 기기에서 아직 보지 않은 것).
    func unseen(server: String, _ updates: [CLIUpdateInfo]?) -> [CLIUpdateInfo] {
        (updates ?? []).filter { $0.announces && !contains(server: server, info: $0) }
    }
}

/// Mac 알림: 판마다 한 번. 앱이 Mac 알림을 맡지 않는 동안 본 판도 '처리함'으로 적는다(그때는 서버가 스크립트 알림을 냈거나
/// 대표가 Mac 알림을 꺼 두었다). 나중에 앱이 알림을 맡아도 옛 판을 다시 알리지 않는다.
struct CLIUpdateNoticeTracker {
    private static let key = "iamceo.macNotifications.cliUpdates.v1"
    private static let limit = 200
    private(set) var handled: [String]
    private let defaults: UserDefaults?

    init(defaults: UserDefaults?) {
        self.defaults = defaults
        handled = defaults?.stringArray(forKey: Self.key) ?? []
    }

    static func identifier(server: String, info: CLIUpdateInfo) -> String { "\(server):cli_update:\(info.cli):\(info.latest ?? "")" }

    /// 지금 알릴 새 판들. 돌려준 판과 맡지 않아 넘긴 판은 처리함으로 적는다.
    mutating func take(_ updates: [CLIUpdateInfo]?, serverID: String, appOwnsNotifications: Bool) -> [CLIUpdateInfo] {
        let fresh = (updates ?? []).filter { $0.announces && !handled.contains(Self.identifier(server: serverID, info: $0)) }
        guard !fresh.isEmpty else { return [] }
        handled.append(contentsOf: fresh.map { Self.identifier(server: serverID, info: $0) })
        if handled.count > Self.limit { handled.removeFirst(handled.count - Self.limit) }
        defaults?.set(handled, forKey: Self.key)
        return appOwnsNotifications ? fresh : []
    }
}

// MARK: - Panel

/// 설정 › 실행 환경이 쥐는 업데이트 상태: 이 기기가 따로 읽은 값(시작 응답·다시 확인·진행 읽기)과 시작 요청의 오류.
@MainActor @Observable final class CLIUpdatesPanel {
    private(set) var local: [String: CLIUpdateInfo] = [:]
    private(set) var starting: Set<String> = []
    private(set) var errors: [String: String] = [:]
    /// 서버가 업데이트 경로를 모른다(옛 서버, 404).
    private(set) var unsupported = false
    private var owner: ObjectIdentifier?

    func attach(_ api: APIClient?) {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
    }

    func reset() { local = [:]; starting = []; errors = [:]; unsupported = false }

    func shown(_ cli: String, server: [CLIUpdateInfo]?) -> CLIUpdateInfo? {
        CLIUpdateMerge.shown(server: server?.first { $0.cli == cli }, local: local[cli])
    }

    /// 서버 스냅샷이 바뀌었다: 서버가 따라잡은 이 기기 값을 지운다.
    func noteServer(_ updates: [CLIUpdateInfo]?) {
        for (cli, mine) in local where CLIUpdateMerge.serverCaughtUp(server: updates?.first { $0.cli == cli }, local: mine) {
            local[cli] = nil
        }
    }

    /// GET /api/cli-updates. 옛 서버(404)는 조용히 넘어간다.
    func load(_ api: APIClient?, refresh: Bool = false) async {
        guard let api, !unsupported else { return }
        do {
            let result = try await api.cliUpdates(refresh: refresh)
            for info in result.updates { local[info.cli] = info }
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            unsupported = true
        } catch {
            // 읽기 실패는 서버 스냅샷 값을 그대로 보이게 둔다(다음 소식 때 다시 읽는다).
        }
    }

    func start(_ info: CLIUpdateInfo, api: APIClient?) async {
        guard let api, !starting.contains(info.cli) else { return }
        starting.insert(info.cli); errors[info.cli] = nil
        defer { starting.remove(info.cli) }
        do {
            let run = try await api.startCLIUpdate(cli: info.cli, to: info.latest)
            var mine = local[info.cli] ?? info
            mine.run = run
            local[info.cli] = mine
        } catch let failure as APIError {
            errors[info.cli] = failure.localizedDescription
            // 최신 판이 바뀌었거나 이미 도는 업데이트가 있으면 지금 값을 다시 읽는다.
            if ["cli_update_changed", "cli_update_running", "cli_update_none"].contains(failure.code ?? "") { await load(api) }
        } catch is CancellationError {
        } catch {
            errors[info.cli] = error is URLError ? String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") : String(localized: "업데이트를 시작하지 못했습니다.")
        }
    }
}
