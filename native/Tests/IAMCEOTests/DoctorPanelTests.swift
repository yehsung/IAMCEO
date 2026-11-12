import Foundation
import XCTest
@testable import IAMCEO

/// B3·D8(앱): 설정 '실행 환경'의 점검표(GET /api/doctor)와 '진단 파일 만들기'(POST /api/diagnose).
/// 점검표는 관대하게 읽고, 옛 서버(404)면 예전 줄을 그대로 두며, 진단 파일은 서버가 있는 Mac 에서만 만든다.
@MainActor final class DoctorPanelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private static let report = #"""
    {"checkedAt":"2026-11-13T03:00:00.000Z","serverVersion":"0.2.4","checks":[
      {"id":"server","state":"ok","title":"서버","detail":"실행 중 · 0.2.4"},
      {"id":"claude","state":"warn","title":"Claude Code","detail":"설치됨 · 로그인 기록을 찾지 못했습니다","fix":"터미널에서 claude를 실행해 로그인하세요."},
      {"id":"engine","state":"fail","title":"실행 엔진","fix":"IAMCEO 앱을 다시 설치하세요."},
      {"id":"codex","state":"unknown","title":"Codex","detail":"설치하지 않았습니다"}
    ]}
    """#

    func testReportDecodesLenientlyAndMapsStates() throws {
        let decoded = try decode(DoctorReport.self, Self.report)
        XCTAssertEqual(decoded.serverVersion, "0.2.4")
        XCTAssertEqual(decoded.checks.map(\.id), ["server", "claude", "engine", "codex"])
        XCTAssertEqual(decoded.checks.map(\.stateLabel), ["정상", "확인 필요", "문제 있음", "확인 못 함"])
        XCTAssertEqual(decoded.checks.map(\.tone), [.success, .attention, .danger, .neutral])
        XCTAssertEqual(decoded.checks.map(\.needsAction), [false, true, true, false])
        XCTAssertNil(decoded.checks[0].fix)
        // 모르는 상태 글자·필드는 읽되 '확인 못 함'으로 보인다. 읽지 못한 항목 하나는 그 항목만 버린다.
        let odd = try decode(DoctorReport.self, #"{"checks":[{"id":"x","state":"paused","title":"새 항목","extra":1},{"id":3},{"id":"y","title":"상태 없음","state":7}]}"#)
        XCTAssertEqual(odd.checks.map(\.id), ["x", "y"])
        XCTAssertEqual(odd.checks.map(\.stateLabel), ["확인 못 함", "확인 못 함"])
        XCTAssertEqual(odd.serverVersion, "")
        XCTAssertThrowsError(try decode(DoctorReport.self, #"{"checkedAt":"x"}"#), "checks 가 없으면 점검표가 아니다")
        let file = try decode(DiagnosticsFile.self, #"{"path":"/Users/me/.iamceo/diagnostics/20261113-030405.zip","sizeBytes":20480,"createdAt":"2026-11-13T03:04:05.000Z"}"#)
        XCTAssertEqual(file.sizeText, "20 KB")
    }

    func testLoadShowsTheListAndKeepsTheOldRowsOnAnOlderServer() async throws {
        let state = DoctorReplyBox(status: 200, body: Self.report)
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/doctor")
            let (status, body) = state.reply
            return IsolatedTestHTTPReply(status: status, data: Data(body.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = DoctorPanel()
        await panel.attach(api)
        XCTAssertEqual(panel.report?.checks.count, 4)
        XCTAssertFalse(panel.unsupported)
        XCTAssertNil(panel.error)
        XCTAssertFalse(panel.loading)

        // 다시 읽다 실패하면 마지막 점검표는 두고 까닭만 보인다.
        state.set(500, #"{"error":"서버 오류"}"#)
        await panel.load(api)
        XCTAssertEqual(panel.report?.checks.count, 4)
        XCTAssertEqual(panel.error, "서버 오류")

        // 옛 서버는 경로를 모른다(404): 예전 세 줄로 돌아간다.
        state.set(404, #"{"error":"없는 경로입니다"}"#)
        await panel.load(api)
        XCTAssertNil(panel.report)
        XCTAssertTrue(panel.unsupported)
        XCTAssertNil(panel.error)

        // 다른 연결로 바뀌면 앞 서버의 결과를 먼저 지운다.
        state.set(200, Self.report)
        await panel.attach(api)
        XCTAssertNotNil(panel.report)
        let other = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 503, data: Data(#"{"error":"서버를 시작하는 중입니다","code":"STARTING"}"#.utf8)) }
        defer { Task { await other.close() } }
        await panel.attach(other.makeAPIClient())
        XCTAssertNil(panel.report)
        XCTAssertEqual(panel.error, "서버를 시작하는 중입니다")
    }

    func testDiagnosticsPostsAndExplainsRefusals() async throws {
        let state = DoctorReplyBox(status: 200, body: #"{"path":"/Users/me/.iamceo/diagnostics/20261113-030405.zip","sizeBytes":4096,"createdAt":"2026-11-13T03:04:05.000Z"}"#)
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/diagnose")
            let (status, body) = state.reply
            return IsolatedTestHTTPReply(status: status, data: Data(body.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = DoctorPanel()
        await panel.makeDiagnostics(api)
        XCTAssertEqual(panel.diagnostics?.path, "/Users/me/.iamceo/diagnostics/20261113-030405.zip")
        XCTAssertEqual(panel.diagnostics?.sizeText, "4 KB")
        XCTAssertNil(panel.diagnoseError)
        XCTAssertFalse(panel.diagnosing)

        state.set(403, #"{"error":"이 Mac 안에서만 쓸 수 있는 경로입니다","code":"LOCAL_ONLY"}"#)
        await panel.makeDiagnostics(api)
        XCTAssertEqual(panel.diagnoseError, "진단 파일은 서버가 있는 Mac에서만 만들 수 있습니다.")

        state.set(404, #"{"error":"없는 경로입니다"}"#)
        await panel.makeDiagnostics(api)
        XCTAssertEqual(panel.diagnoseError, "이 서버 버전은 진단 파일을 만들 수 없습니다. IAMCEO를 새 버전으로 올려 주세요.")

        state.set(507, #"{"error":"저장 공간이 부족해 처리하지 못했습니다.","code":"storage_full"}"#)
        await panel.makeDiagnostics(api)
        XCTAssertEqual(panel.diagnoseError, "저장 공간이 부족해 처리하지 못했습니다.")
        // 마지막으로 만든 파일은 그대로 보인다.
        XCTAssertNotNil(panel.diagnostics)
    }

    /// 리뷰 app-2: 진단 파일을 만드는 동안 점검표를 다시 읽으면(설정의 '다시 확인') 결과를 버리고 '만드는 중'에서 멈췄다.
    func testReloadingTheListWhileMakingDiagnosticsStillFinishesIt() async throws {
        let gate = DoctorGate()
        let report = Self.report
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/diagnose" {
                return IsolatedTestHTTPReply(data: Data(#"{"path":"/Users/me/.iamceo/diagnostics/a.zip","sizeBytes":2048,"createdAt":"2026-11-13T03:04:05.000Z"}"#.utf8),
                                             beforeDelivery: { await gate.wait() })
            }
            return IsolatedTestHTTPReply(data: Data(report.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = DoctorPanel()
        await panel.attach(api)
        let making = Task { await panel.makeDiagnostics(api) }
        while !panel.diagnosing { await Task.yield() }
        await panel.load(api)
        XCTAssertTrue(panel.diagnosing)
        await gate.open()
        await making.value
        XCTAssertEqual(panel.diagnostics?.path, "/Users/me/.iamceo/diagnostics/a.zip")
        XCTAssertFalse(panel.diagnosing, "다시 누를 수 있다")
        XCTAssertEqual(panel.report?.checks.count, 4)

        // 연결이 바뀌어 reset 하면 만드는 중 표시도 풀린다(늦게 온 결과는 버린다).
        await gate.close()
        let again = Task { await panel.makeDiagnostics(api) }
        while !panel.diagnosing { await Task.yield() }
        panel.reset()
        XCTAssertFalse(panel.diagnosing)
        await gate.open()
        await again.value
        XCTAssertNil(panel.diagnostics)
        XCTAssertFalse(panel.diagnosing)
    }
}

/// 시험 서버가 답을 내보내기 전에 기다리는 문.
private actor DoctorGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() { isOpen = true; for waiter in waiters { waiter.resume() }; waiters = [] }
    func close() { isOpen = false }
}

/// 시험 서버의 답을 바꾸는 자리. URLProtocol 은 다른 스레드에서 읽는다.
private final class DoctorReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int
    private var body: String
    init(status: Int, body: String) { self.status = status; self.body = body }
    var reply: (Int, String) { lock.withLock { (status, body) } }
    func set(_ status: Int, _ body: String) { lock.withLock { self.status = status; self.body = body } }
}
