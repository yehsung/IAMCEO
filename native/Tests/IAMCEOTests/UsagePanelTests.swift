import Foundation
import XCTest
@testable import IAMCEO

/// T(F6)(앱): 설정 → AI 모델의 '사용량'(GET /api/usage). 관대하게 읽고, CLI 가 보고하지 않은 값은 채우지 않으며,
/// 옛 서버(404)면 묶음을 숨긴다.
@MainActor final class UsagePanelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// 서버 tests/usage.test.ts 의 GET /api/usage 모양.
    private static let report = #"""
    {"generatedAt":"2026-11-13T03:00:00.000Z","timeZone":"Asia/Seoul","days":7,"from":"2026-11-07","to":"2026-11-13","projectId":null,"retentionDays":90,
     "totals":{"costUsd":5.75,"inputTokens":6000,"outputTokens":800},
     "members":[
      {"memberId":"m1","projectId":"p1","name":"결제 연동","kind":"worker","providers":["claude"],"removed":false,"lastAt":"2026-11-13T02:59:00.000Z","costUsd":5.5,"inputTokens":1000,"outputTokens":100},
      {"memberId":"m2","projectId":"p2","name":"화면 정리","kind":"worker","providers":["claude"],"removed":true,"lastAt":"2026-11-13T02:59:30.000Z","costUsd":0.25,"inputTokens":null,"outputTokens":null},
      {"memberId":"m3","projectId":"p1","name":"정산 검토","kind":"conductor","providers":["codex"],"removed":false,"lastAt":"2026-11-13T02:59:50.000Z","costUsd":null,"inputTokens":5000,"outputTokens":700}],
     "projects":[
      {"projectId":"p1","name":"결제 앱","archived":false,"members":2,"costUsd":5.5,"inputTokens":6000,"outputTokens":800},
      {"projectId":"p2","name":"홈페이지","archived":true,"members":1,"costUsd":0.25,"inputTokens":null,"outputTokens":null}],
     "daily":[{"day":"2026-11-10","costUsd":4,"inputTokens":null,"outputTokens":null},{"day":"2026-11-13","costUsd":1.75,"inputTokens":6000,"outputTokens":800}],
     "limits":[{"provider":"claude","window":"five_hour","windowMinutes":300,"usedPct":22.4,"resetsAt":"2026-11-13T04:00:00.000Z","observedAt":"2026-11-13T02:59:00.000Z"},
               {"provider":"claude","window":"seven_day_opus","windowMinutes":10080,"usedPct":81,"resetsAt":null,"observedAt":"2026-11-13T02:58:00.000Z"},
               {"provider":"codex","window":"primary","windowMinutes":300,"usedPct":18,"resetsAt":null,"observedAt":"2026-11-13T02:59:50.000Z"},
               {"provider":"codex","window":"odd","windowMinutes":null,"usedPct":5,"resetsAt":null,"observedAt":"2026-11-13T02:59:50.000Z"}]}
    """#

    func testReportDecodesLenientlyAndKeepsMissingValuesMissing() throws {
        let decoded = try decode(UsageReport.self, Self.report)
        XCTAssertEqual(decoded.days, 7)
        XCTAssertEqual(decoded.retentionDays, 90)
        XCTAssertEqual(decoded.totals, UsageAmounts(costUsd: 5.75, inputTokens: 6000, outputTokens: 800))
        XCTAssertEqual(decoded.members.map(\.name), ["결제 연동", "화면 정리", "정산 검토"])
        // Codex 는 비용을 보고하지 않는다: 0 이 아니라 없음이다.
        XCTAssertNil(decoded.members[2].amounts.costUsd)
        XCTAssertEqual(decoded.members[2].amounts.tokens, 5700)
        XCTAssertNil(decoded.members[1].amounts.tokens)
        XCTAssertTrue(decoded.members[1].removed)
        XCTAssertEqual(decoded.projects.map(\.members), [2, 1])
        XCTAssertEqual(decoded.daily.map(\.day), ["2026-11-10", "2026-11-13"])
        XCTAssertEqual(decoded.limits.count, 4)
        // 읽지 못한 줄은 그 줄만 버리고, 모르는 필드는 건너뛴다.
        let odd = try decode(UsageReport.self, #"{"members":[{"memberId":"a","name":"가","costUsd":"x","extra":1},{"name":"id 없음"}],"totals":"bad","limits":[{"provider":"claude"}]}"#)
        XCTAssertEqual(odd.members.map(\.memberId), ["a"])
        XCTAssertNil(odd.members[0].amounts.costUsd)
        XCTAssertEqual(odd.totals, UsageAmounts())
        XCTAssertEqual(odd.limits, [])
        XCTAssertThrowsError(try decode(UsageReport.self, #"{"days":7}"#), "members 가 없으면 사용량 보고가 아니다")
    }

    func testTextShowsWhatTheCLIReported() throws {
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(UsageText.cost(12.3456, locale: en), "$12.35")
        XCTAssertEqual(UsageText.cost(1234.5, locale: en), "$1,234.50")
        XCTAssertEqual(UsageText.cost(0.001, locale: en), "<$0.01")
        XCTAssertEqual(UsageText.cost(0, locale: en), "$0.00")
        XCTAssertEqual(UsageText.tokenCount(1_234_567, locale: en), "1.2M")
        XCTAssertEqual(UsageText.tokenCount(950, locale: en), "950")
        XCTAssertEqual(UsageText.tokenCount(1_234_567, locale: Locale(identifier: "ko_KR")), "123만")
        // 비용이 있으면 비용, 아래 줄은 토큰. 비용이 없으면(Codex) 토큰, 아래 줄은 입력·출력.
        XCTAssertEqual(UsageText.primary(UsageAmounts(costUsd: 5.5, inputTokens: 1000, outputTokens: 100), locale: en), "$5.50")
        XCTAssertEqual(UsageText.secondary(UsageAmounts(costUsd: 5.5, inputTokens: 1000, outputTokens: 100), locale: en), "토큰 1.1K")
        XCTAssertNil(UsageText.secondary(UsageAmounts(costUsd: 0.25), locale: en))
        XCTAssertEqual(UsageText.primary(UsageAmounts(inputTokens: 5000, outputTokens: 700), locale: en), "토큰 5.7K")
        XCTAssertEqual(UsageText.secondary(UsageAmounts(inputTokens: 5000, outputTokens: 700), locale: en), "입력 5K · 출력 700")
        XCTAssertEqual(UsageText.primary(UsageAmounts()), "—")

        let report = try decode(UsageReport.self, Self.report)
        // 아는 창만, CLI 별 한 줄. 모델이 붙은 Claude 창은 그 이름을 붙인다.
        let groups = UsageText.limitGroups(report.limits)
        XCTAssertEqual(groups.map(\.provider), ["claude", "codex"])
        XCTAssertEqual(UsageText.limitsValue(groups[0].limits), "5시간 22% · 주간 Opus 81%")
        XCTAssertEqual(UsageText.limitsValue(groups[1].limits), "5시간 18%")
        XCTAssertEqual(UsageText.limitsTitle("claude"), "Claude 사용 한도")
        let now = try XCTUnwrap(parseISODate("2026-11-13T03:00:00.000Z"))
        let hint = UsageText.limitsHint(groups[0].limits, now: now)
        XCTAssertTrue(hint.hasPrefix("1분 전 기준 · 5시간 한도 "), hint)
        XCTAssertTrue(hint.hasSuffix(" 초기화"), hint)
        XCTAssertNil(UsageText.windowLabel(UsageLimitWindow(provider: "codex", window: "odd", windowMinutes: nil, usedPct: 1)))
        XCTAssertEqual(UsageText.windowLabel(UsageLimitWindow(provider: "codex", window: "secondary", windowMinutes: 10_080, usedPct: 1)), "주간")
        XCTAssertEqual(UsageText.windowLabel(UsageLimitWindow(provider: "codex", window: "x", windowMinutes: 120, usedPct: 1)), "2시간")

        // 나눠 보기: 팀원(큰 것부터, 프로젝트 이름·직급·CLI·닫음), 프로젝트, 날짜(새 날부터).
        let members = UsageText.lines(report, by: .members, now: now)
        XCTAssertEqual(members.map(\.title), ["결제 연동", "화면 정리", "정산 검토"])
        XCTAssertEqual(members.map(\.hint), ["결제 앱 · 팀장 · Claude", "홈페이지 · 팀장 · Claude · 닫음", "결제 앱 · 총괄 · Codex"])
        XCTAssertEqual(UsageText.lines(report, by: .projects, now: now).map(\.hint), ["2명", "1명 · 보관됨"])
        let calendar = Calendar.current
        let today = calendar.dateComponents([.year, .month, .day], from: Date())
        let todayKey = String(format: "%04d-%02d-%02d", today.year!, today.month!, today.day!)
        XCTAssertEqual(UsageText.dayLabel(todayKey), "오늘")
        // 합계 줄: 하루면 그날만, 여러 날이면 첫날 – 끝날.
        XCTAssertEqual(UsageText.totalHint(UsageReport(days: 1, from: todayKey, to: todayKey)), "오늘")
        XCTAssertTrue(UsageText.totalHint(UsageReport(days: 7, from: "2026-11-07", to: todayKey)).hasSuffix(" – 오늘"))
        XCTAssertEqual(UsageText.lines(report, by: .days, now: now).map(\.id), ["2026-11-13", "2026-11-10"])
        XCTAssertEqual(UsageText.dayLabel("not-a-day"), "not-a-day")
    }

    /// 4차 리뷰 lang-2: 영어 화면의 날짜는 영어 달 이름이다(예전에는 ko_KR 고정이라 "11월 7일 (토)"였다).
    /// 문구 표가 없는 시험에서는 '기준'·'초기화' 같은 문구가 한국어로 남으므로 날짜 조각만 본다.
    func testUsageDatesFollowTheAppLanguage() throws {
        let now = try XCTUnwrap(parseISODate("2026-11-13T03:00:00.000Z"))
        let limits = [UsageLimitWindow(provider: "claude", window: "five_hour", windowMinutes: 300, usedPct: 22,
                                       resetsAt: "2026-11-16T12:00:00.000Z", observedAt: "2026-11-13T02:59:00.000Z")]
        XCTAssertEqual(UsageText.dayLabel("2026-11-07", now: now), "11월 7일 (토)", "한국어 화면은 예전 그대로")
        XCTAssertTrue(UsageText.limitsHint(limits, now: now).contains("11월 16일"))
        AppLanguage.withOverride(.en) {
            let day = UsageText.dayLabel("2026-11-07", now: now)
            XCTAssertFalse(SourceLiterals.hasHangul(day), day)
            XCTAssertTrue(day.contains("Nov") && day.contains("7") && day.contains("Sat"), day)
            XCTAssertFalse(UsageText.totalHint(UsageReport(days: 7, from: "2026-11-07", to: "2026-11-10"), now: now).contains("월"))
            let hint = UsageText.limitsHint(limits, now: now)
            XCTAssertTrue(hint.contains("Nov 16") || hint.contains("16 Nov"), hint)
            XCTAssertFalse(hint.contains("11월"), hint)
        }
    }

    func testLoadAsksForThePeriodAndHidesOnAnOlderServer() async throws {
        let state = UsageReplyBox(status: 200, body: Self.report)
        let paths = UsagePathLog()
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "GET")
            paths.append(request.url.map { "\($0.path)?\($0.query ?? "")" } ?? "")
            let (status, body) = state.reply
            return IsolatedTestHTTPReply(status: status, data: Data(body.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = UsagePanel()
        await panel.attach(api)
        XCTAssertEqual(panel.report?.members.count, 3)
        XCTAssertFalse(panel.unsupported)
        XCTAssertNil(panel.error)
        XCTAssertFalse(panel.loading)

        panel.days = 30
        await panel.load(api)
        XCTAssertEqual(paths.all, ["/api/usage?days=7", "/api/usage?days=30"])

        // 다시 읽다 실패하면 마지막 값은 두고 까닭만 보인다.
        state.set(500, #"{"error":"서버 오류"}"#)
        await panel.load(api)
        XCTAssertEqual(panel.report?.members.count, 3)
        XCTAssertEqual(panel.error, "서버 오류")
        // 4차 리뷰 ui-7: 영어 화면은 코드의 영어 문장(서버의 한국어 대표 문장을 그대로 보이지 않는다).
        state.set(500, #"{"error":"서버 오류가 났습니다","code":"internal_error"}"#)
        await AppLanguage.withOverrideAsync(.en) { await panel.load(api) }
        XCTAssertEqual(panel.error, "Something went wrong on the server")
        await panel.load(api)
        XCTAssertEqual(panel.error, "서버 오류가 났습니다", "한국어 화면은 받은 문장 그대로")

        // 옛 서버는 경로를 모른다(404): 묶음을 숨긴다.
        state.set(404, #"{"error":"없는 경로입니다","code":"route_not_found"}"#)
        await panel.load(api)
        XCTAssertNil(panel.report)
        XCTAssertTrue(panel.unsupported)
        XCTAssertNil(panel.error)

        // 다른 연결로 바뀌면 앞 서버의 값을 먼저 지운다.
        state.set(200, Self.report)
        await panel.attach(api)
        XCTAssertNotNil(panel.report)
        let other = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 503, data: Data(#"{"error":"서버를 시작하는 중입니다","code":"STARTING"}"#.utf8)) }
        defer { Task { await other.close() } }
        await panel.attach(other.makeAPIClient())
        XCTAssertNil(panel.report)
        XCTAssertFalse(panel.unsupported)
        XCTAssertEqual(panel.error, "서버를 시작하는 중입니다")
    }
}

private final class UsageReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int
    private var body: String
    init(status: Int, body: String) { self.status = status; self.body = body }
    var reply: (Int, String) { lock.withLock { (status, body) } }
    func set(_ status: Int, _ body: String) { lock.withLock { self.status = status; self.body = body } }
}

private final class UsagePathLog: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String] = []
    func append(_ path: String) { lock.withLock { paths.append(path) } }
    var all: [String] { lock.withLock { paths } }
}
