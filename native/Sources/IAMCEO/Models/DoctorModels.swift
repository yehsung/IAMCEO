import Foundation
import Observation

// B3·D8: 설정의 '실행 환경' 점검표(GET /api/doctor)와 진단 파일(POST /api/diagnose).
// 옛 서버는 두 경로를 모른다(404). 그때 화면은 예전 세 줄(실행 엔진·Claude Code·Codex CLI)을 그대로 보인다.

/// 점검 한 항목. 서버가 모르는 상태 글자를 보내도 버리지 않고 '확인 못 함'으로 읽는다.
struct DoctorCheck: Codable, Sendable, Equatable, Identifiable {
    var id: String
    /// ok · warn · fail · unknown
    var state: String = "unknown"
    var title: String
    var detail: String? = nil
    /// 일반 사용자가 할 수 있는 고치는 법 한 줄. 정상이면 없다.
    var fix: String? = nil

    enum CodingKeys: String, CodingKey { case id, state, title, detail, fix }

    init(id: String, state: String = "unknown", title: String, detail: String? = nil, fix: String? = nil) {
        self.id = id
        self.state = state
        self.title = title
        self.detail = detail
        self.fix = fix
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        state = c.lenient(String.self, forKey: .state) ?? "unknown"
        detail = c.lenient(String.self, forKey: .detail)
        fix = c.lenient(String.self, forKey: .fix)
    }

    var tone: Tone {
        switch state {
        case "ok": .success
        case "warn": .attention
        case "fail": .danger
        default: .neutral
        }
    }

    /// 줄 오른쪽에 점과 함께 보이는 짧은 말.
    var stateLabel: String {
        switch state {
        case "ok": String(localized: "정상")
        case "warn": String(localized: "확인 필요")
        case "fail": String(localized: "문제 있음")
        default: String(localized: "확인 못 함")
        }
    }

    /// 고치는 법을 주의 색으로 보일지. 쓰지 않는 선택 기능의 안내(확인 못 함)는 평범한 색으로 둔다.
    var needsAction: Bool { state == "warn" || state == "fail" }
}

struct DoctorReport: Codable, Sendable, Equatable {
    var checkedAt: String = ""
    var serverVersion: String = ""
    var checks: [DoctorCheck] = []

    enum CodingKeys: String, CodingKey { case checkedAt, serverVersion, checks }

    init(checkedAt: String = "", serverVersion: String = "", checks: [DoctorCheck] = []) {
        self.checkedAt = checkedAt
        self.serverVersion = serverVersion
        self.checks = checks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checkedAt = c.lenient(String.self, forKey: .checkedAt) ?? ""
        serverVersion = c.lenient(String.self, forKey: .serverVersion) ?? ""
        // 읽지 못한 항목 하나 때문에 점검표 전체를 버리지 않는다.
        checks = try c.requiredLossyArray(DoctorCheck.self, forKey: .checks)
    }
}

/// POST /api/diagnose 의 답. path 는 서버가 있는 Mac 의 .zip 절대 경로.
struct DiagnosticsFile: Codable, Sendable, Equatable {
    var path: String
    var sizeBytes: Int
    var createdAt: String

    var sizeText: String { "\(max(1, Int((Double(sizeBytes) / 1024).rounded()))) KB" }
}

/// 설정 화면이 쥐는 점검표·진단 파일 상태. 연결이 바뀌면 reset 한다.
@MainActor @Observable final class DoctorPanel {
    private(set) var report: DoctorReport?
    /// 서버가 점검을 모른다(옛 서버). 이때 화면은 예전 줄을 그대로 보인다.
    private(set) var unsupported = false
    private(set) var loading = false
    private(set) var error: String?
    private(set) var diagnostics: DiagnosticsFile?
    private(set) var diagnosing = false
    private(set) var diagnoseError: String?
    /// 점검표 읽기의 세대. 다시 읽으면 앞 읽기의 결과를 버린다.
    private var token = 0
    /// 진단 파일 만들기의 세대. 점검표를 다시 읽어도(설정의 '다시 확인') 만드는 중인 진단은 그대로 끝나야 하므로 따로 센다.
    private var diagnoseToken = 0
    private var owner: ObjectIdentifier?

    /// 이 연결의 점검표를 읽는다. 다른 서버(다른 연결)로 바뀌었으면 앞 서버의 결과를 먼저 지운다.
    func attach(_ api: APIClient?) async {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
        await load(api)
    }

    func reset() {
        token &+= 1; diagnoseToken &+= 1
        report = nil; unsupported = false; loading = false; error = nil
        diagnostics = nil; diagnoseError = nil; diagnosing = false
    }

    /// 다시 읽는 동안에도 마지막 점검표는 그대로 둔다.
    func load(_ api: APIClient?) async {
        guard let api else { return }
        token &+= 1
        let mine = token
        loading = true
        defer { if mine == token { loading = false } }
        do {
            let result: DoctorReport = try await api.request("/api/doctor")
            guard mine == token else { return }
            report = result; unsupported = false; error = nil
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == token else { return }
            report = nil; unsupported = true; error = nil
        } catch is CancellationError {
        } catch {
            guard mine == token, !Task.isCancelled else { return }
            self.error = Self.message(error, fallback: String(localized: "점검표를 읽지 못했습니다."))
        }
    }

    func makeDiagnostics(_ api: APIClient?) async {
        guard let api, !diagnosing else { return }
        diagnoseToken &+= 1
        let mine = diagnoseToken
        diagnosing = true; diagnoseError = nil
        defer { if mine == diagnoseToken { diagnosing = false } }
        do {
            let result: DiagnosticsFile = try await api.request("/api/diagnose", method: "POST", timeout: 90)
            guard mine == diagnoseToken else { return }
            diagnostics = result
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == diagnoseToken else { return }
            diagnoseError = String(localized: "이 서버 버전은 진단 파일을 만들 수 없습니다. IAMCEO를 새 버전으로 올려 주세요.")
        } catch let failure as APIError where failure.code == "LOCAL_ONLY" {
            guard mine == diagnoseToken else { return }
            diagnoseError = String(localized: "진단 파일은 서버가 있는 Mac에서만 만들 수 있습니다.")
        } catch is CancellationError {
        } catch {
            guard mine == diagnoseToken, !Task.isCancelled else { return }
            diagnoseError = Self.message(error, fallback: String(localized: "진단 파일을 만들지 못했습니다."))
        }
    }

    private static func message(_ error: Error, fallback: String) -> String {
        if let failure = error as? APIError, !failure.message.isEmpty { return failure.localizedDescription }
        if error is URLError { return String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") }
        return fallback
    }
}
