import SwiftUI

// T(F6): 설정 → AI 모델 끝의 '사용량' 묶음(Mac·iPhone 같은 모양, 설정의 다른 묶음과 같은 부품).
// 기간(오늘·7일·30일), 합계, 계정 한도, 그리고 팀원별·프로젝트별·날짜별 줄. 값은 CLI 가 보고한 그대로다(UsageText).
// 옛 서버(404)면 아무것도 그리지 않는다. 그때 AI 모델 화면은 예전 그대로다.

/// 나눠 보는 기준.
enum UsageBreakdown: String, CaseIterable, Hashable, Sendable {
    case members, projects, days
    var title: String {
        switch self {
        case .members: String(localized: "팀원별")
        case .projects: String(localized: "프로젝트별")
        case .days: String(localized: "날짜별")
        }
    }
    static var items: [(value: UsageBreakdown, title: String)] { allCases.map { ($0, $0.title) } }
}

/// 한 CLI 의 한도 창들(한 줄로 보인다).
struct UsageLimitGroup: Identifiable, Sendable, Equatable {
    let provider: String
    let limits: [UsageLimitWindow]
    var id: String { provider }
}

/// 나눠 본 한 줄(팀원·프로젝트·날짜 가운데 하나).
struct UsageLine: Identifiable, Sendable, Equatable {
    let id: String
    let title: String
    let hint: String?
    let amounts: UsageAmounts
}

extension UsageText {
    /// 고른 기준의 줄들. 팀원·프로젝트는 서버 순서(큰 것부터), 날짜는 새 날부터.
    static func lines(_ report: UsageReport, by breakdown: UsageBreakdown, now: Date = Date()) -> [UsageLine] {
        switch breakdown {
        case .members:
            let names = Dictionary(report.projects.map { ($0.projectId, $0.name) }, uniquingKeysWith: { first, _ in first })
            return report.members.map { UsageLine(id: $0.memberId, title: $0.name, hint: memberHint($0, projectName: names[$0.projectId]), amounts: $0.amounts) }
        case .projects:
            return report.projects.map { UsageLine(id: $0.projectId, title: $0.name, hint: projectHint($0), amounts: $0.amounts) }
        case .days:
            return report.daily.reversed().map { UsageLine(id: $0.day, title: dayLabel($0.day, now: now), hint: nil, amounts: $0.amounts) }
        }
    }

    /// CLI 별 한도 묶음(아는 창이 하나라도 있는 것만). Claude 먼저.
    static func limitGroups(_ limits: [UsageLimitWindow]) -> [UsageLimitGroup] {
        let known = limits.filter { windowLabel($0) != nil }
        return ["claude", "codex"].compactMap { provider in
            let mine = known.filter { $0.provider == provider }
            return mine.isEmpty ? nil : UsageLimitGroup(provider: provider, limits: mine)
        }
    }
}

struct UsageGroup: View {
    @Environment(AppStore.self) private var store
    @State private var panel = UsagePanel()
    @State private var breakdown: UsageBreakdown = .members
    @State private var expanded = false
    /// 펼치기 전에 보이는 줄 수.
    static let collapsedRows = 8

    var body: some View {
        content
            .task(id: reloadKey) { await panel.attach(store.api) }
            .onChange(of: breakdown) { _, _ in expanded = false }
    }

    /// 연결이 바뀌거나 기간을 바꾸면 다시 읽는다.
    private var reloadKey: String {
        "\(store.api.map { "\(ObjectIdentifier($0).hashValue)" } ?? "none")|\(panel.days)"
    }

    private var period: Binding<Int> { Binding(get: { panel.days }, set: { panel.days = $0 }) }

    @ViewBuilder private var content: some View {
        if !panel.unsupported, store.api != nil {
            // 읽기 실패는 묶음 아래 한 줄(위험 색)로, 평소에는 숫자가 무엇인지 적는다.
            let problem = panel.error
            SettingsGroup(String(localized: "사용량"), footnote: problem ?? panel.report.map { UsageText.footnote(retentionDays: $0.retentionDays) },
                          footnoteTone: problem == nil ? CE.ink2 : CE.danger, accessory: {
                SettingsRefreshButton(label: String(localized: "사용량 다시 읽기"), busy: panel.loading) { Task { await panel.load(store.api) } }
                    .disabled(store.connectionStatus != .connected)
            }) {
                SettingsRow(String(localized: "기간")) {
                    CESegmentPill(selection: period, items: UsageText.periods, stretch: false)
                        .accessibilityLabel(String(localized: "기간"))
                }
                RowDivider(inset: 0)
                if let report = panel.report {
                    rows(report)
                } else {
                    SettingsRow(String(localized: "합계"), hint: panel.loading ? String(localized: "불러오는 중") : String(localized: "연결한 뒤 볼 수 있습니다")) {
                        if panel.loading { ProgressView().controlSize(.small) }
                    }
                }
            }
        }
    }

    @ViewBuilder private func rows(_ report: UsageReport) -> some View {
        SettingsRow(String(localized: "합계"), hint: UsageText.totalHint(report)) { UsageValue(amounts: report.totals) }
        ForEach(UsageText.limitGroups(report.limits)) { group in
            RowDivider(inset: 0)
            SettingsRow(UsageText.limitsTitle(group.provider), hint: UsageText.limitsHint(group.limits)) {
                // 80% 를 넘은 창이 있으면 주의 색. 값은 CLI 가 보고한 사용률 그대로다.
                Text(UsageText.limitsValue(group.limits))
                    .font(SetupFont.value).monospacedDigit()
                    .foregroundStyle(group.limits.contains { $0.usedPct >= 80 } ? CE.attention : CE.ink)
                    .lineLimit(1).fixedSize()
            }
        }
        RowDivider(inset: 0)
        if report.members.isEmpty {
            SettingsRow(String(localized: "이 기간에 모은 사용량이 없습니다"), hint: String(localized: "팀원이 일하면 Claude Code와 Codex가 보고한 수치가 여기에 쌓입니다.")) { EmptyView() }
        } else {
            SettingsRow(String(localized: "나눠 보기"), stacksOnPhone: true) {
                CESegmentPill(selection: $breakdown, items: UsageBreakdown.items, stretch: !isMac)
                    .accessibilityLabel(String(localized: "나눠 보기"))
            }
            let lines = UsageText.lines(report, by: breakdown)
            ForEach(Array(lines.prefix(expanded ? lines.count : Self.collapsedRows))) { line in
                RowDivider(inset: 0)
                SettingsRow(line.title, hint: line.hint) { UsageValue(amounts: line.amounts) }
            }
            if lines.count > Self.collapsedRows {
                RowDivider(inset: 0)
                Button { expanded.toggle() } label: {
                    Text(expanded ? String(localized: "접기") : String(localized: "모두 보기 (\(lines.count))"))
                        .font(CEFont.meta).foregroundStyle(CE.accent)
                        .frame(maxWidth: .infinity, minHeight: isMac ? 44 : 48, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// 줄 오른쪽의 값: 큰 글자(비용, 없으면 토큰)와 그 아래 작은 글자(토큰 또는 입력·출력).
private struct UsageValue: View {
    let amounts: UsageAmounts
    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(UsageText.primary(amounts)).font(SetupFont.value).monospacedDigit().foregroundStyle(CE.ink)
            if let secondary = UsageText.secondary(amounts) {
                Text(secondary).font(SetupFont.hint).monospacedDigit().foregroundStyle(CE.ink2)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}
