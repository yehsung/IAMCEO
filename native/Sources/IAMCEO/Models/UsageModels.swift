import Foundation
import Observation

// T(F6): 설정 → AI 모델의 '사용량'(GET /api/usage). 팀원·프로젝트·날짜별로 CLI 가 보고한 값을 그대로 보인다.
// 비용은 Claude Code 가 보고한 금액이고 Codex 는 토큰만 보고한다. 앱은 아무것도 계산해 채우지 않는다(없으면 없다고 보인다).
// 옛 서버는 경로를 모른다(404): 그때 이 묶음은 보이지 않는다.

/// CLI 가 보고한 값의 합. 그 범위에서 보고한 기록이 없으면 nil(0 과 다르다).
struct UsageAmounts: Sendable, Equatable {
    var costUsd: Double?
    var inputTokens: Int?
    var outputTokens: Int?

    init(costUsd: Double? = nil, inputTokens: Int? = nil, outputTokens: Int? = nil) {
        self.costUsd = costUsd; self.inputTokens = inputTokens; self.outputTokens = outputTokens
    }

    fileprivate enum Keys: String, CodingKey { case costUsd, inputTokens, outputTokens }
    fileprivate init(_ decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        costUsd = c.lenient(Double.self, forKey: .costUsd).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        inputTokens = c.lenient(Int.self, forKey: .inputTokens).flatMap { $0 >= 0 ? $0 : nil }
        outputTokens = c.lenient(Int.self, forKey: .outputTokens).flatMap { $0 >= 0 ? $0 : nil }
    }

    /// 입력·출력 토큰의 합. 둘 다 없으면 nil.
    var tokens: Int? { inputTokens == nil && outputTokens == nil ? nil : (inputTokens ?? 0) + (outputTokens ?? 0) }
}

struct UsageMemberRow: Decodable, Sendable, Equatable, Identifiable {
    var memberId: String
    var projectId: String
    var name: String
    /// root · conductor · worker
    var kind: String
    /// claude · codex(도중에 CLI 를 바꾸면 둘)
    var providers: [String]
    /// 팀원을 닫아 명부에 없다.
    var removed: Bool
    var lastAt: String
    var amounts: UsageAmounts
    var id: String { memberId }

    enum CodingKeys: String, CodingKey { case memberId, projectId, name, kind, providers, removed, lastAt }
    init(memberId: String, projectId: String, name: String, kind: String = "worker", providers: [String] = ["claude"], removed: Bool = false, lastAt: String = "", amounts: UsageAmounts) {
        self.memberId = memberId; self.projectId = projectId; self.name = name; self.kind = kind; self.providers = providers; self.removed = removed; self.lastAt = lastAt; self.amounts = amounts
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberId = try c.decode(String.self, forKey: .memberId)
        projectId = c.lenient(String.self, forKey: .projectId) ?? ""
        name = c.lenient(String.self, forKey: .name) ?? ""
        kind = c.lenient(String.self, forKey: .kind) ?? "worker"
        providers = c.lenientArray(String.self, forKey: .providers) ?? []
        removed = c.lenient(Bool.self, forKey: .removed) ?? false
        lastAt = c.lenient(String.self, forKey: .lastAt) ?? ""
        amounts = try UsageAmounts(decoder)
    }
}

struct UsageProjectRow: Decodable, Sendable, Equatable, Identifiable {
    var projectId: String
    var name: String
    var archived: Bool
    /// 그 기간에 수치가 있는 팀원 수(닫은 팀원 포함).
    var members: Int
    var amounts: UsageAmounts
    var id: String { projectId }

    enum CodingKeys: String, CodingKey { case projectId, name, archived, members }
    init(projectId: String, name: String, archived: Bool = false, members: Int = 1, amounts: UsageAmounts) {
        self.projectId = projectId; self.name = name; self.archived = archived; self.members = members; self.amounts = amounts
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decode(String.self, forKey: .projectId)
        name = c.lenient(String.self, forKey: .name) ?? ""
        archived = c.lenient(Bool.self, forKey: .archived) ?? false
        members = c.lenient(Int.self, forKey: .members) ?? 0
        amounts = try UsageAmounts(decoder)
    }
}

struct UsageDayRow: Decodable, Sendable, Equatable, Identifiable {
    /// 서버가 도는 Mac 의 날짜(YYYY-MM-DD).
    var day: String
    var amounts: UsageAmounts
    var id: String { day }

    enum CodingKeys: String, CodingKey { case day }
    init(day: String, amounts: UsageAmounts) { self.day = day; self.amounts = amounts }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = try c.decode(String.self, forKey: .day)
        amounts = try UsageAmounts(decoder)
    }
}

/// 계정 한도의 마지막 사용률(계정 전체 값이라 팀원별로 나누지 않는다).
struct UsageLimitWindow: Decodable, Sendable, Equatable, Identifiable {
    var provider: String
    /// Claude: five_hour · seven_day(_opus 등), Codex: primary · secondary
    var window: String
    var windowMinutes: Int?
    var usedPct: Double
    var resetsAt: String?
    var observedAt: String
    var id: String { "\(provider).\(window)" }

    enum CodingKeys: String, CodingKey { case provider, window, windowMinutes, usedPct, resetsAt, observedAt }
    init(provider: String, window: String, windowMinutes: Int?, usedPct: Double, resetsAt: String? = nil, observedAt: String = "") {
        self.provider = provider; self.window = window; self.windowMinutes = windowMinutes; self.usedPct = usedPct; self.resetsAt = resetsAt; self.observedAt = observedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        window = try c.decode(String.self, forKey: .window)
        usedPct = try c.decode(Double.self, forKey: .usedPct)
        windowMinutes = c.lenient(Int.self, forKey: .windowMinutes)
        resetsAt = c.lenient(String.self, forKey: .resetsAt)
        observedAt = c.lenient(String.self, forKey: .observedAt) ?? ""
    }
}

struct UsageReport: Decodable, Sendable, Equatable {
    var generatedAt: String
    var days: Int
    var from: String
    var to: String
    var retentionDays: Int
    var totals: UsageAmounts
    var members: [UsageMemberRow]
    var projects: [UsageProjectRow]
    var daily: [UsageDayRow]
    var limits: [UsageLimitWindow]

    enum CodingKeys: String, CodingKey { case generatedAt, days, from, to, retentionDays, totals, members, projects, daily, limits }
    private struct Totals: Decodable { let value: UsageAmounts; init(from decoder: Decoder) throws { value = try UsageAmounts(decoder) } }

    init(generatedAt: String = "", days: Int = 7, from: String = "", to: String = "", retentionDays: Int = 90, totals: UsageAmounts = UsageAmounts(),
         members: [UsageMemberRow] = [], projects: [UsageProjectRow] = [], daily: [UsageDayRow] = [], limits: [UsageLimitWindow] = []) {
        self.generatedAt = generatedAt; self.days = days; self.from = from; self.to = to; self.retentionDays = retentionDays
        self.totals = totals; self.members = members; self.projects = projects; self.daily = daily; self.limits = limits
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // 팀원 목록이 없으면 이 경로의 답이 아니다. 읽지 못한 줄 하나는 그 줄만 버린다.
        members = try c.requiredLossyArray(UsageMemberRow.self, forKey: .members)
        generatedAt = c.lenient(String.self, forKey: .generatedAt) ?? ""
        days = c.lenient(Int.self, forKey: .days) ?? 7
        from = c.lenient(String.self, forKey: .from) ?? ""
        to = c.lenient(String.self, forKey: .to) ?? ""
        retentionDays = c.lenient(Int.self, forKey: .retentionDays) ?? 90
        totals = c.lenient(Totals.self, forKey: .totals)?.value ?? UsageAmounts()
        projects = c.lenientArray(UsageProjectRow.self, forKey: .projects) ?? []
        daily = c.lenientArray(UsageDayRow.self, forKey: .daily) ?? []
        limits = c.lenientArray(UsageLimitWindow.self, forKey: .limits) ?? []
    }
}

/// 화면 글자. 시험이 같은 함수를 부른다.
enum UsageText {
    static let periods: [(value: Int, title: String)] = [(1, String(localized: "오늘")), (7, String(localized: "\(7)일")), (30, String(localized: "\(30)일"))]

    /// "$12.34". 0보다 크지만 1센트가 안 되면 "<$0.01".
    static func cost(_ usd: Double, locale: Locale = .current) -> String {
        if usd > 0 && usd < 0.005 { return "<$0.01" }
        return "$" + usd.formatted(.number.precision(.fractionLength(2)).locale(locale))
    }

    /// 토큰 수를 짧게(한국어 "120만", 영어 "1.2M").
    static func tokenCount(_ count: Int, locale: Locale = .current) -> String {
        count.formatted(.number.notation(.compactName).locale(locale))
    }

    /// 줄 오른쪽의 큰 글자: 비용이 있으면 비용, 없으면(Codex) 토큰.
    static func primary(_ amounts: UsageAmounts, locale: Locale = .current) -> String {
        if let cost = amounts.costUsd { return Self.cost(cost, locale: locale) }
        if let tokens = amounts.tokens { return String(localized: "토큰 \(tokenCount(tokens, locale: locale))") }
        return "—"
    }

    /// 그 아래 작은 글자: 비용을 보였으면 토큰 합, 토큰을 보였으면 입력·출력.
    static func secondary(_ amounts: UsageAmounts, locale: Locale = .current) -> String? {
        if amounts.costUsd != nil { return amounts.tokens.map { String(localized: "토큰 \(tokenCount($0, locale: locale))") } }
        guard let input = amounts.inputTokens, let output = amounts.outputTokens else { return nil }
        return String(localized: "입력 \(tokenCount(input, locale: locale)) · 출력 \(tokenCount(output, locale: locale))")
    }

    /// 한도 창의 이름. 모르는 창이면 nil(그 창은 보이지 않는다).
    static func windowLabel(_ limit: UsageLimitWindow) -> String? {
        let model: String? = {
            guard limit.provider == "claude", let range = limit.window.range(of: #"^(five_hour|seven_day)_"#, options: .regularExpression) else { return nil }
            let rest = limit.window[range.upperBound...]
            return rest.isEmpty ? nil : rest.prefix(1).uppercased() + rest.dropFirst()
        }()
        let base: String?
        switch limit.windowMinutes {
        case 300: base = String(localized: "5시간")
        case 10_080: base = String(localized: "주간")
        case let minutes? where minutes > 0 && minutes % 60 == 0: base = String(localized: "\(minutes / 60)시간")
        default: base = nil
        }
        guard let base else { return nil }
        return model.map { "\(base) \($0)" } ?? base
    }

    static func percent(_ value: Double) -> String { "\(Int(value.rounded()))%" }

    /// "5시간 23% · 주간 41%". 아는 창만.
    static func limitsValue(_ limits: [UsageLimitWindow]) -> String {
        limits.compactMap { limit in windowLabel(limit).map { "\($0) \(percent(limit.usedPct))" } }.joined(separator: " · ")
    }

    /// "3분 전 기준 · 5시간 한도 14:20 초기화". 초기화 시각은 가장 가까운 것 하나만.
    static func limitsHint(_ limits: [UsageLimitWindow], now: Date = Date()) -> String {
        var parts: [String] = []
        let newest = limits.max { (parseISODate($0.observedAt) ?? .distantPast) < (parseISODate($1.observedAt) ?? .distantPast) }
        if let newest, case let seen = relativeTime(newest.observedAt, now: now), !seen.isEmpty { parts.append(String(localized: "\(seen) 기준")) }
        let next = limits.compactMap { limit -> (Date, String)? in
            guard let at = parseISODate(limit.resetsAt), at > now, let label = windowLabel(limit) else { return nil }
            return (at, label)
        }.min { $0.0 < $1.0 }
        if let (at, label) = next {
            let calendar = Calendar.current
            let when = calendar.isDate(at, inSameDayAs: now) ? koTime(at) : "\(appFormatted(at, ko: "M월 d일", en: "MMMd")) \(koTime(at))"
            parts.append(String(localized: "\(label) 한도 \(when) 초기화"))
        }
        return parts.joined(separator: " · ")
    }

    static func limitsTitle(_ provider: String) -> String {
        String(localized: "\(providerName(provider)) 사용 한도")
    }

    /// 날짜 줄 이름: 오늘 · 어제 · 11월 12일 (목).
    static func dayLabel(_ day: String, now: Date = Date()) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)) else { return day }
        if Calendar.current.isDate(date, inSameDayAs: now) { return String(localized: "오늘") }
        if let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now), Calendar.current.isDate(date, inSameDayAs: yesterday) { return String(localized: "어제") }
        return appFormatted(date, ko: "M월 d일 (E)", en: "EEEMMMd")
    }

    static func memberHint(_ row: UsageMemberRow, projectName: String?) -> String {
        var parts: [String] = []
        if let projectName, !projectName.isEmpty { parts.append(projectName) }
        parts.append(rankName(row.kind))
        if !row.providers.isEmpty { parts.append(row.providers.map(providerName).joined(separator: "·")) }
        if row.removed { parts.append(String(localized: "닫음")) }
        return parts.joined(separator: " · ")
    }

    static func projectHint(_ row: UsageProjectRow) -> String {
        var parts = [String(localized: "\(row.members)명")]
        if row.archived { parts.append(String(localized: "보관됨")) }
        return parts.joined(separator: " · ")
    }

    /// 합계 줄의 기간: "11월 7일 (토) – 오늘". 하루면 그날만.
    static func totalHint(_ report: UsageReport, now: Date = Date()) -> String {
        report.from.isEmpty || report.from == report.to ? dayLabel(report.to, now: now) : "\(dayLabel(report.from, now: now)) – \(dayLabel(report.to, now: now))"
    }

    static func footnote(retentionDays: Int) -> String {
        String(localized: "비용은 Claude Code가 보고한 금액 그대로이며, 구독 요금제라면 실제 청구액과 다를 수 있습니다. Codex는 토큰 수만 보고합니다. 날짜는 서버가 수치를 받은 때로 나누고, \(retentionDays)일 동안 보관합니다.")
    }
}

/// 설정 화면이 쥐는 사용량 상태. 연결이 바뀌면 앞 서버의 값을 지운다.
@MainActor @Observable final class UsagePanel {
    private(set) var report: UsageReport?
    /// 서버가 사용량을 모른다(옛 서버). 이때 묶음을 보이지 않는다.
    private(set) var unsupported = false
    private(set) var loading = false
    private(set) var error: String?
    /// 고른 기간(1·7·30일). 바꾸면 화면이 다시 읽는다.
    var days = 7
    private var token = 0
    private var owner: ObjectIdentifier?

    func attach(_ api: APIClient?) async {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
        await load(api)
    }

    func reset() {
        token &+= 1
        report = nil; unsupported = false; loading = false; error = nil
    }

    /// 다시 읽는 동안에도 마지막 값은 그대로 둔다(기간을 바꿔도 빈 칸으로 깜빡이지 않는다).
    func load(_ api: APIClient?) async {
        guard let api else { return }
        token &+= 1
        let mine = token
        loading = true
        defer { if mine == token { loading = false } }
        do {
            let result: UsageReport = try await api.request("/api/usage?days=\(days)")
            guard mine == token else { return }
            report = result; unsupported = false; error = nil
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == token else { return }
            report = nil; unsupported = true; error = nil
        } catch is CancellationError {
        } catch {
            guard mine == token, !Task.isCancelled else { return }
            // 화면 언어의 문장(영어 화면은 코드의 영어 문장). 4차 리뷰 ui-7.
            if let failure = error as? APIError, !failure.message.isEmpty { self.error = failure.localizedDescription }
            else if error is URLError { self.error = String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") }
            else { self.error = String(localized: "사용량을 읽지 못했습니다.") }
        }
    }
}
