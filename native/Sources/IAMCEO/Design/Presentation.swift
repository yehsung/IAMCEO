import Foundation

// Pure mapping from server values to honest Korean UI language. No View code here so it stays testable.
// Labels match the web client so the same person sees the same words on every device.

func providerName(_ cli: String) -> String {
    switch cli { case "claude": "Claude"; case "codex": "Codex"; default: cli.capitalized }
}

func providerFullName(_ cli: String) -> String {
    switch cli { case "claude": "Claude Code"; case "codex": "Codex CLI"; default: cli }
}

func rankName(_ kind: String) -> String {
    switch kind { case "conductor": "총괄"; case "root": "본사 AI"; case "worker": "팀장"; default: kind }
}

/// CLI execution state of a member. Never a statement about task completion — only a `완료` report says that.
struct MemberStatusInfo: Sendable {
    let label: String
    let tone: Tone
    let icon: String
    let explanation: String
    let live: Bool
    let needsMe: Bool

    init(_ status: String) {
        switch status {
        case "working":
            label = "일하는 중"; tone = .live; icon = "bolt.fill"; live = true; needsMe = false
            explanation = "지금 일을 처리하고 있습니다. 뒤에서 도는 작업을 기다리는 동안도 일하는 중으로 봅니다."
        case "waiting":
            label = "내 답 기다림"; tone = .attention; icon = "hourglass"; live = false; needsMe = true
            explanation = "답하지 않은 결재가 있습니다. 답을 기다리는 동안 다른 일을 계속할 수도 있습니다."
        case "blocked":
            label = "승인 창 앞"; tone = .approval; icon = "hand.raised.fill"; live = false; needsMe = true
            explanation = "승인이나 선택을 묻는 창 앞에서 멈췄습니다. 결재함이나 터미널에서 골라 주세요."
        case "idle":
            label = "쉬는 중"; tone = .neutral; icon = "pause.circle"; live = false; needsMe = false
            explanation = "다음 지시를 기다립니다. 맡은 일이 끝났는지는 보고로 확인하세요."
        case "asleep":
            label = "잠듦"; tone = .dim; icon = "moon.zzz"; live = false; needsMe = false
            explanation = "세션을 내려 두었습니다. 기록은 남아 있고, 깨우거나 지시를 보내면 다시 엽니다."
        case "offline":
            label = "안 보임"; tone = .dim; icon = "eye.slash"; live = false; needsMe = false
            explanation = "실행 중인 화면을 찾지 못했습니다. 새 지시가 오면 다시 엽니다."
        case "error":
            label = "오류"; tone = .danger; icon = "exclamationmark.triangle.fill"; live = false; needsMe = true
            explanation = "일을 시작하거나 이어 가다 실패했습니다. 오류 내용을 보고 깨우거나 새로 시작하세요."
        default:
            label = status; tone = .neutral; icon = "questionmark.circle"; live = false; needsMe = false
            explanation = "알 수 없는 상태입니다."
        }
    }

    /// Display order for summaries (most urgent first).
    static let order = ["blocked", "waiting", "error", "working", "idle", "offline", "asleep"]
    static func rank(_ status: String) -> Int { order.firstIndex(of: status) ?? order.count }

    static func isProgressAdvisory(_ code: String?) -> Bool {
        code == "progress_stalled" || code == "start_stalled"
    }

    static func observationUnavailable(_ member: Member) -> Bool {
        guard let observation = member.statusObservation else { return false }
        return observation.freshness != "fresh" || observation.ownership != "verified" ||
            (observation.error != nil && !isProgressAdvisory(observation.error?.code) && !member.hasFolderTrustApproval)
    }

    /// Shared by badges and all member summaries; never classify by a display icon.
    static func isUncertain(_ member: Member) -> Bool {
        observationUnavailable(member) || !order.contains(member.status) ||
            (member.status == "blocked" && !["permission", "selection"].contains(member.blockedReason ?? "") && !member.hasFolderTrustApproval)
    }

    static func summaryCounts(_ members: [Member]) -> [String: Int] {
        Dictionary(grouping: members, by: { isUncertain($0) ? "unknown" : $0.status }).mapValues(\.count)
    }

    static func progressNote(_ member: Member, now: Date = Date()) -> String? {
        guard isProgressAdvisory(member.statusObservation?.error?.code), !observationUnavailable(member) else { return nil }
        let run = member.executionState
        let since = run?.lastProgressAt ?? run?.startedAt ?? run?.inputReceivedAt
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = since.flatMap { formatter.date(from: $0) }
        formatter.formatOptions = [.withInternetDateTime]
        let date = fractional ?? since.flatMap { formatter.date(from: $0) }
        if let date {
            let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
            return "화면 출력 없이 \(minutes)분째 진행 중"
        }
        return "화면 출력 없이 진행 중입니다. 일하는 중인 것은 확인됩니다."
    }

    /// Prefer this overload when the server supplies observation metadata.
    init(_ member: Member) {
        let observation = member.statusObservation
        if observation?.ownership == "conflict" {
            self.init(label: "소유 관계 확인 필요", tone: .attention, icon: "lock.trianglebadge.exclamationmark",
                      explanation: "이 직원의 화면을 다른 곳에서도 잡고 있어 마지막 상태만 보여 줍니다. 자동 전달은 멈춰 둡니다.", needsMe: true)
        } else if Self.observationUnavailable(member) {
            self.init(label: "상태 확인 불가", tone: .attention, icon: "questionmark.circle",
                      explanation: observation?.error?.note ?? "지금 상태를 읽지 못했습니다. 마지막으로 본 상태를 보여 주며 다시 확인하고 있습니다.")
        } else if member.status == "blocked", !["permission", "selection"].contains(member.blockedReason ?? ""), !member.hasFolderTrustApproval {
            self.init(label: member.blockedReason == "setup" ? "상태 설정 확인 중" : "상태 확인 불가",
                      tone: .attention, icon: "questionmark.circle", explanation: "승인 창인지 아직 확인하지 못했습니다. 다시 확인하는 동안 자동 전달은 멈춰 둡니다.")
        } else if member.origin == "manual" {
            let base = Self(member.status)
            self.init(label: "\(base.label) · 추정", tone: base.tone, icon: base.icon,
                      explanation: "마지막 활동으로 짐작한 상태입니다. 실제로 일하는지는 확인하지 못했습니다.", needsMe: base.needsMe)
        } else if !Self.order.contains(member.status) {
            self.init(label: "상태 확인 불가", tone: .neutral, icon: "questionmark.circle", explanation: "알 수 없는 상태입니다. 잠시 뒤 다시 확인합니다.")
        } else {
            let base = Self(member.status)
            self.init(label: base.label, tone: base.tone, icon: base.icon,
                      explanation: Self.progressNote(member) ?? base.explanation, live: base.live, needsMe: base.needsMe)
        }
    }

    private init(label: String, tone: Tone, icon: String, explanation: String, live: Bool = false, needsMe: Bool = false) {
        self.label = label; self.tone = tone; self.icon = icon; self.explanation = explanation
        self.live = live; self.needsMe = needsMe
    }
}

extension Member {
    var hasFolderTrustApproval: Bool {
        status == "blocked" && backend == "core" && blockedReason == "setup" &&
        statusObservation?.source == "core" && statusObservation?.freshness == "fresh" &&
        statusObservation?.ownership == "verified" && statusObservation?.error?.code == "folder_trust"
    }
    var canReadCLIApproval: Bool {
        guard paneId != nil, MemberStatusInfo(self).tone == .approval else { return false }
        return hasFolderTrustApproval || (backend == "herdr" && status == "blocked" && ["permission", "selection"].contains(blockedReason ?? ""))
    }
}

/// Dedicated timestamps never fall back to a general DB modification timestamp.
struct MemberObservationInfo: Sendable {
    let lastObservedAt: String?
    let lastStatus: String
    let error: String?
    let manualActivityAt: String?
    init(_ member: Member) {
        lastObservedAt = member.statusObservation?.observedAt
        lastStatus = MemberStatusInfo(member.status).label
        error = MemberStatusInfo.progressNote(member) ?? member.statusObservation?.error?.note ?? member.lastError
        manualActivityAt = member.origin == "manual" ? member.manualActivityAt : nil
    }
}

struct SubagentInfo: Sendable {
    let label: String
    let count: Int?
    let observedAt: String?
    init(_ member: Member) {
        observedAt = member.subagentState?.observedAt
        switch member.subagentState?.quality {
        case "exact", "estimated":
            if let value = member.subagentState?.count, value >= 0 {
                count = value
                label = "서브에이전트 \(value)개" + (member.subagentState?.quality == "estimated" ? " · 추정" : "")
            } else { count = nil; label = "서브에이전트 수 확인 불가" }
        case "unsupported": count = nil; label = "서브에이전트 수 미지원"
        default: count = nil; label = "서브에이전트 수 미수집"
        }
    }
}

struct LastReportInfo: Sendable {
    let label = "마지막 보고"
    let text: String
    let reportedAt: String?
    let next: String
    init(_ member: Member) {
        text = member.now.isEmpty ? "아직 보고가 없습니다" : member.now
        reportedAt = member.nowAt
        next = member.next
    }
}

/// Delivery of one of my messages. Delivered means the CLI received it as input, not that work finished.
struct DeliveryInfo: Sendable {
    let label: String
    let tone: Tone
    let icon: String
    let explanation: String

    init?(_ delivery: String?) {
        guard let delivery else { return nil }
        switch delivery {
        case "queued":
            label = "전달 대기"; tone = .neutral; icon = "clock"
            explanation = "저장했습니다. 받는 사람 차례가 되면 넣습니다."
        case "held":
            label = "보류"; tone = .attention; icon = "pause.circle"
            explanation = "자동 전달을 멈췄습니다. 이유를 확인하고 해결하면 다시 전달합니다."
        case "delivering":
            label = "넣는 중"; tone = .neutral; icon = "arrow.up.circle"
            explanation = "받는 사람 입력칸에 넣는 중입니다."
        case "delivered":
            label = "받음"; tone = .success; icon = "checkmark.circle"
            explanation = "받는 사람에게 들어갔습니다. 일을 끝냈다는 뜻은 아닙니다."
        case "failed":
            label = "실패"; tone = .danger; icon = "exclamationmark.circle"
            explanation = "받는 사람에게 넣지 못했습니다. 같은 글을 다시 보낼 수 있습니다."
        default:
            label = delivery; tone = .neutral; icon = "questionmark.circle"; explanation = ""
        }
    }

    init(_ item: DeliveryNoticeItem) {
        switch item.phase {
        case .checking:
            self.init(label: "전달 확인 중", tone: .neutral, icon: "magnifyingglass", explanation: "받았는지 시스템이 확인하고 있습니다.")
        case .retryWait:
            self.init(label: "자동 재전송 대기", tone: .neutral, icon: "arrow.clockwise", explanation: "안전한지 다시 확인한 뒤 자동으로 넣습니다. 아직 받은 것은 아닙니다.")
        case .needsOwner:
            self.init(label: "전달 확인 필요", tone: .attention, icon: "exclamationmark.circle", explanation: item.reasonDescription)
        case .waiting:
            self.init(label: "전달 대기", tone: .neutral, icon: "clock", explanation: item.reasonDescription)
        case .stopped:
            self.init(label: "추가 전달 중지", tone: .dim, icon: "pause.circle", explanation: "추가 전달을 중지했습니다. 과거 수신 여부는 알 수 없습니다.")
        case .resolved where item.status == "delivered":
            self.init(label: "받음", tone: .success, icon: "checkmark.circle", explanation: "받는 사람에게 들어갔습니다. 일을 끝냈다는 뜻은 아닙니다.")
        case .some(.none) where item.reason == "not_received":
            self.init(label: item.status == "held" ? "입력 확인 대기" : "전달 대기", tone: .neutral, icon: "clock", explanation: item.reasonDescription)
        case .some(.none):
            self = Self(item.status) ?? Self(label: "전달 상태 확인 불가", tone: .neutral, icon: "questionmark.circle", explanation: "최신 전달 근거를 다시 확인해 주세요.")
        default:
            self.init(label: "전달 상태 확인 불가", tone: .neutral, icon: "questionmark.circle", explanation: "최신 전달 근거를 다시 확인해 주세요.")
        }
    }

    init(_ summary: MemberDeliverySummary) {
        if summary.needsOwnerCount > 0 {
            self.init(label: "전달 확인 \(Self.badgeCount(summary.needsOwnerCount))", tone: .attention,
                      icon: "exclamationmark.circle", explanation: "전달 확인이 필요한 항목 \(summary.needsOwnerCount)건입니다.")
        } else if summary.checkingCount > 0 || summary.unknownCount > 0 {
            self.init(label: "전달 확인 중", tone: .neutral, icon: "magnifyingglass", explanation: "시스템이 수신 근거를 확인하고 있습니다. 대표의 수신 판정은 필요하지 않습니다.")
        } else if summary.deliveringCount > 0 {
            self.init(label: "전달 중", tone: .neutral, icon: "arrow.up.circle", explanation: "넣는 중입니다. 아직 받은 것은 아닙니다.")
        } else {
            self.init(label: summary.undeliveredCount > 0 ? "전달 대기" : "전달 문제 없음", tone: .neutral, icon: "clock", explanation: "미전달 \(max(0, summary.undeliveredCount))건 · 뒤에서 대기 \(max(0, summary.waitingBehindCount))건")
        }
    }

    var needsOwner: Bool { tone == .attention }
    static func badgeCount(_ count: Int) -> String { count > 99 ? "99+" : String(max(0, count)) }
    private init(label: String, tone: Tone, icon: String, explanation: String) {
        self.label = label; self.tone = tone; self.icon = icon; self.explanation = explanation
    }
}

/// Home shows only nonzero delivery details; full recovery counts stay in member details.
func homeDeliverySummary(_ summary: MemberDeliverySummary) -> String? {
    let parts = [("미확인", summary.unknownCount),
                 ("미전달", summary.undeliveredCount),
                 ("뒤에서 대기", summary.waitingBehindCount)]
        .filter { $0.1 > 0 }
        .map { "\($0.0) \($0.1)" }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

struct DeliveryEvidenceInfo: Sendable {
    let sourceLabel: String
    let label: String
    let detail: String
    init(_ evidence: DeliveryEvidence) {
        switch evidence.source {
        case "claude_log": sourceLabel = "Claude 주 세션 입력 기록"
        case "codex_log": sourceLabel = "Codex 주 세션 입력 기록"
        case "transport": sourceLabel = "터미널 응답"
        case "core_screen", "herdr_screen": sourceLabel = evidence.location == "composer" ? "입력칸" : "터미널 화면"
        default: sourceLabel = "전달 근거"
        }
        switch evidence.verdict {
        case .present:
            label = "확인됨"
            if evidence.location == "composer" {
                detail = "입력칸의 내용을 확인했습니다. CLI가 입력을 받았다는 뜻은 아닙니다."
            } else {
                detail = "해당 위치에서 근거를 확인했습니다. 업무 완료를 뜻하지 않습니다."
            }
        case .absent where evidence.complete: label = "해당 없음"; detail = "완전하게 확인한 범위에 근거가 없습니다. 이것만으로 미수신을 확정하지 않습니다."
        default: label = "취득 불가"; detail = "근거를 완전하게 확인하지 못했습니다. 미수신을 뜻하지 않습니다."
        }
    }
}

/// A single policy shared by the panel and its tests. Future phases/reasons permit read-only rechecks only.
func deliveryPanelActions(_ item: DeliveryNoticeItem) -> [DeliveryRecoveryAction] {
    guard let deliveryID = item.deliveryId, !deliveryID.isEmpty, let version = item.version, version > 0,
          item.phase != .resolved, item.phase != .stopped, item.phase != .some(.none) else { return [] }
    return [.recheck, .retryWithRisk, .stopRetry].filter { action in
        item.safeAllowedActions.contains(action) && (action == .recheck || item.phase == .needsOwner)
            && (action == .recheck || item.reason != "duplicate_draft")
            && (action != .retryWithRisk || ["retry_exhausted", "log_missing", "log_incomplete", "unsupported_schema"].contains(item.reason ?? "")
                || (item.evidence ?? []).contains { $0.code == "complete_range_without_marker" && $0.verdict == .absent && $0.complete })
    }
}

/// Decision lifecycle: open → answered (saved, waiting to reach the asker) → delivered (asker's CLI received it), or closed.
struct DecisionStateInfo: Sendable {
    let label: String
    let tone: Tone

    init(_ decision: Decision) {
        switch decision.status {
        case "open":
            label = decision.options.isEmpty ? "답변 요청" : "선택 요청"; tone = .attention
        case "answered":
            label = "답함 · 전달 대기"; tone = .neutral
        case "delivered":
            label = "답함 · 담당자가 받음"; tone = .success
        case "closed":
            label = "닫힘"; tone = .dim
        default:
            label = decision.status; tone = .neutral
        }
    }
}

func closeKindName(_ kind: String?) -> String? {
    switch kind {
    case "decided": "대표가 이미 정함"
    case "obsolete": "필요 없어짐"
    default: nil
    }
}

func messageKindTone(_ kind: String) -> Tone {
    switch kind {
    case "완료": .success
    case "질문": .attention
    case "막힘": .danger
    case "진행": .live
    default: .neutral
    }
}

func activityKindName(_ kind: String) -> String {
    switch kind {
    case "text": "글"; case "tool": "도구"; case "tool_result": "결과"; case "turn_start": "시작"
    case "turn_end": "끝"; case "compact": "압축"; case "error": "오류"; case "system": "알림"
    default: kind
    }
}

enum WorkSection: String, CaseIterable, Identifiable, Sendable {
    case doing, next, hold, done
    var id: String { rawValue }
    var title: String { switch self { case .doing: "진행 중"; case .next: "예정"; case .hold: "보류"; case .done: "완료" } }
    var tone: Tone { switch self { case .doing: .live; case .next: .neutral; case .hold: .attention; case .done: .success } }
}

/// Something that stops work until the CEO acts. Each case keeps its own data meaning.
enum StopItem: Identifiable, Sendable {
    case approval(Member)
    case memberError(Member)
    case failedDelivery(Message)
    case heldDelivery(Message)

    var id: String {
        switch self {
        case .approval(let m): "approval:\(m.id)"
        case .memberError(let m): "error:\(m.id)"
        case .failedDelivery(let m): "failed:\(m.id)"
        case .heldDelivery(let m): "held:\(m.id)"
        }
    }
}

/// Newest first; for equal timestamps the later-registered item comes first.
func newestFirst(_ decisions: [Decision]) -> [Decision] {
    Array(decisions.reversed()).sorted { $0.createdAt > $1.createdAt }
}

/// The server's `delivery_unknown` hold. It is never retried automatically and it freezes every later delivery to
/// that member (decision answers and todo notices included) until someone checks the terminal.
func isDeliveryUnknownHold(_ message: Message) -> Bool {
    message.delivery == "held" && (message.deliveryNote ?? "").hasPrefix("전달 여부를 확인할 수 없어")
}

/// My messages whose delivery still needs the CEO, newest first.
/// - failed: never retried and never delivered by a later message, so every one stays until it is resent (same id)
///   or the same text and attachments were sent again to the same target.
/// - held: normally released in order once the hold clears, so only the latest per target is shown; a
///   `delivery_unknown` hold never clears by itself and is always shown.
func unresolvedDeliveries(_ messages: [Message], status: String) -> [Message] {
    let mine = messages.filter(\.mine)
    func targetKey(_ message: Message) -> String { message.targetMemberId ?? "chief" }
    if status == "failed" {
        func sameContent(_ a: Message, _ b: Message) -> Bool {
            targetKey(a) == targetKey(b)
                && a.body.trimmingCharacters(in: .whitespacesAndNewlines) == b.body.trimmingCharacters(in: .whitespacesAndNewlines)
                && a.attachments.map(\.id) == b.attachments.map(\.id)
        }
        var result: [Message] = []
        for (index, message) in mine.enumerated() where message.delivery == "failed" {
            let sentAgain = mine[(index + 1)...].contains { $0.delivery != "failed" && sameContent($0, message) }
            if !sentAgain { result.append(message) }
        }
        return result.sorted { $0.at > $1.at }
    }
    var latestByTarget: [String: Message] = [:]
    for message in mine { latestByTarget[targetKey(message)] = message }
    var result = latestByTarget.values.filter { $0.delivery == status }
    if status == "held" {
        let shown = Set(result.map(\.id))
        result += mine.filter { isDeliveryUnknownHold($0) && !shown.contains($0.id) }
    }
    return result.sorted { $0.at > $1.at }
}

/// What one project needs from the CEO, for project menus: "결재 2 · 할 일 1 · 승인 창 앞 1명 · 2명 일하는 중".
func projectStatusLine(_ project: ProjectSummary) -> String {
    var parts: [String] = []
    if !project.connection.ok { parts.append("연결 문제") }
    if project.decisionCount > 0 { parts.append("결재 \(project.decisionCount)") }
    if project.todoCount > 0 { parts.append("할 일 \(project.todoCount)") }
    if project.blockedCount > 0 { parts.append("승인 창 앞 \(project.blockedCount)명") }
    if project.errorCount > 0 { parts.append("오류 \(project.errorCount)명") }
    if project.workingCount > 0 { parts.append("\(project.workingCount)명 일하는 중") }
    return parts.isEmpty ? "개입할 일 없음" : parts.joined(separator: " · ")
}

/// Items in a project that wait on the CEO: open decisions, open todos, members at an approval prompt or in error.
func projectNeedsCount(_ project: ProjectSummary) -> Int {
    project.decisionCount + project.todoCount + project.blockedCount + project.errorCount
}

/// Markdown-free single line (sidebar `now`, window subtitle): drops emphasis/code marks, heading/quote/list
/// markers and line breaks.
func plainOneLine(_ text: String) -> String {
    var value = text
    for mark in ["**", "__", "`"] { value = value.replacingOccurrences(of: mark, with: "") }
    let lines = value.components(separatedBy: .newlines).map { raw -> String in
        var line = raw.trimmingCharacters(in: .whitespaces)
        while line.hasPrefix("#") { line.removeFirst() }
        for marker in ["> ", "- ", "* ", "• "] where line.hasPrefix(marker) { line.removeFirst(marker.count) }
        return line.trimmingCharacters(in: .whitespaces)
    }
    return lines.filter { !$0.isEmpty }.joined(separator: " ")
}

func buildStops(members: [Member], messages: [Message]) -> [StopItem] {
    var items: [StopItem] = []
    items += members.filter { $0.status == "blocked" }.map(StopItem.approval)
    items += members.filter { $0.status == "error" }.map(StopItem.memberError)
    items += unresolvedDeliveries(messages, status: "failed").map(StopItem.failedDelivery)
    items += unresolvedDeliveries(messages, status: "held").map(StopItem.heldDelivery)
    return items
}

/// Reports worth surfacing on Home: newest first; echo kinds (알림, 답변) only fill leftover slots.
func recentReports(_ messages: [Message], limit: Int = 4) -> [Message] {
    let reports = messages.filter { !$0.mine && ["완료", "진행", "질문", "막힘", "알림", "답변"].contains($0.kind) }
    let primary = reports.filter { !["알림", "답변"].contains($0.kind) }.suffix(limit)
    var chosen = Array(primary)
    if chosen.count < limit {
        chosen += reports.filter { ["알림", "답변"].contains($0.kind) }.suffix(limit - chosen.count)
    }
    return chosen.sorted { $0.at > $1.at }
}

/// Raw CLI / runner errors in words the CEO can act on. Known provider messages become one Korean sentence with the
/// next step; anything unknown passes through unchanged (never hide the original when we do not understand it).
func friendlyError(_ raw: String) -> String {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    // The server appends the raw socket detail, e.g. "(hello: connect ENOENT /private/…/core.sock)". The Korean lead says it all.
    if let range = text.range(of: #"\s*\([^()]*(ENOENT|ECONNREFUSED|ETIMEDOUT|hello:|connect )[^()]*\)\s*$"#, options: [.regularExpression, .caseInsensitive]) {
        text.removeSubrange(range)
    }
    let lower = text.lowercased()
    func has(_ needle: String) -> Bool { lower.contains(needle.lowercased()) }
    if has("can't use your claude subscription") || has("payment is past due") {
        return "Claude 구독 결제에 문제가 있어 일을 할 수 없습니다. claude.ai 설정에서 결제를 확인해 주세요."
    }
    if has("no response from api") || has("overloaded") || has("api error: 5") {
        return "AI 서버가 응답하지 않습니다. 잠시 뒤 다시 시도합니다."
    }
    if has("usage limit") || has("rate limit") || has("사용 한도") || has("limit reached") {
        return "사용 한도에 닿았습니다. 한도가 풀리면 다시 이어서 할 수 있습니다."
    }
    if has("not logged in") || has("please run /login") || has("authentication") || has("unauthorized") {
        return "AI 계정 로그인이 풀렸습니다. Mac 터미널에서 다시 로그인해 주세요."
    }
    if has("starting_unknown") { return "세션을 시작했는지 아직 확인하지 못했습니다. 상태를 다시 확인하고 있습니다." }
    if has("cli reported an error") { return "AI 프로그램이 오류를 알렸습니다. 터미널에서 내용을 확인해 주세요." }
    if text.contains("턴이 시작되지 않았습니다") { return text.replacingOccurrences(of: "턴이 시작되지 않았습니다", with: "일을 시작하지 않았습니다") }
    if let range = text.range(of: #"\(?exit(_code)?[ =]?(\d+)\)?"#, options: .regularExpression) {
        let code = text[range].filter(\.isNumber)
        let rest = text.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lead = rest.isEmpty ? "프로그램이 비정상 종료됐습니다" : rest
        return "\(lead) (종료 코드 \(code))"
    }
    return text
}

/// Why a file, page or preview could not be fetched, in words the CEO can act on (A-78): never "Request failed (502)."
/// or an English system string. `what` names the thing ("원본", "페이지"), `verb` the action ("받지", "읽지", "올리지").
/// A Korean server message is kept as is.
func friendlyLoadError(_ error: Error, what: String = "원본", verb: String = "받지") -> String {
    let object = "\(what)\(objectParticle(what))"
    let subject = "\(what)\(subjectParticle(what))"
    if let api = error as? APIError {
        switch api.status {
        case 401, 403: return "접근이 거절됐습니다. 설정에서 연결을 다시 확인해 주세요."
        case 404, 410: return "\(subject) 서버에 없습니다. 지워졌거나 옮겨졌을 수 있습니다."
        case 413: return "\(subject) 너무 커서 앱에서 열 수 없습니다."
        case 500...599: return "서버 문제로 \(object) \(verb) 못했습니다. 잠시 뒤 다시 시도해 주세요."
        default:
            let message = api.message.trimmingCharacters(in: .whitespacesAndNewlines)
            if message.range(of: #"\p{Hangul}"#, options: .regularExpression) != nil { return message }
            return "\(object) \(verb) 못했습니다."
        }
    }
    if let url = error as? URLError {
        switch url.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return "서버와 연결이 끊겨 \(object) \(verb) 못했습니다."
        case .timedOut: return "시간이 너무 오래 걸려 \(object) \(verb) 못했습니다. 다시 시도해 주세요."
        case .cancelled: return "멈췄습니다."
        default: return "\(object) \(verb) 못했습니다."
        }
    }
    if error is DecodingError { return "\(what) 내용을 읽지 못했습니다. 형식이 맞지 않습니다." }
    let text = error.localizedDescription
    if text.range(of: #"\p{Hangul}"#, options: .regularExpression) != nil { return friendlyError(text) }
    return "\(object) \(verb) 못했습니다."
}

/// 을/를 after a Korean word (by its last syllable's final consonant).
func objectParticle(_ word: String) -> String { hasFinalConsonant(word) ? "을" : "를" }
/// 이/가 — the subject form, same rule.
func subjectParticle(_ word: String) -> String { hasFinalConsonant(word) ? "이" : "가" }
private func hasFinalConsonant(_ word: String) -> Bool {
    guard let scalar = word.unicodeScalars.last, (0xAC00...0xD7A3).contains(scalar.value) else { return false }
    return (scalar.value - 0xAC00) % 28 != 0
}

/// Why a delivery is still waiting, in the CEO's words (server `waitReason`, wave UX-T1), with how long it has waited.
/// Shared by the chat bubble's status line, 홈 and the member page: one wording everywhere.
/// `reason`: run_limit · member_busy · waking · receipt_check · approval · manual_control · runner_off · archived · unknown.
/// `since`: ISO time the delivery started waiting. `used`/`limit`: the run-limit slots when reason is run_limit.
func waitReasonLabel(_ reason: String?, since: String? = nil, used: Int? = nil, limit: Int? = nil, now: Date = Date()) -> String? {
    guard let reason, !reason.isEmpty else { return nil }
    let base: String
    switch reason {
    case "run_limit":
        if let used, let limit, limit > 0 { base = "동시에 일하는 직원이 다 차서 차례를 기다리는 중(\(used)/\(limit))" }
        else { base = "동시에 일하는 직원이 다 차서 차례를 기다리는 중" }
    case "member_busy": base = "지금 하던 일이 끝나면 전달"
    // A report or note that does not wake its reader: it goes in with that member's next turn, by design.
    case "next_turn": base = "다음에 일할 때 함께 전달"
    case "waking": base = "깨우는 중"
    case "receipt_check": base = "앞 지시를 받았는지 확인하는 중"
    case "approval": base = "승인 창 앞이라 대기 중"
    case "manual_control": base = "터미널에서 직접 조작 중이라 대기"
    case "runner_off": base = "이 프로젝트 실행이 꺼져 있어 대기"
    case "archived": base = "보관한 프로젝트라 보내지 않음"
    default: base = "전달을 기다리는 중"
    }
    guard let since, let start = parseISODate(since) else { return base }
    let minutes = Int(now.timeIntervalSince(start) / 60)
    if minutes < 1 { return base }
    if minutes < 60 { return "\(base) · \(minutes)분째" }
    let hours = minutes / 60
    return hours < 24 ? "\(base) · \(hours)시간째" : "\(base) · \(hours / 24)일째"
}

/// The tone for a waiting reason: the CEO can act on approval and manual control; the rest resolve on their own.
func waitReasonTone(_ reason: String?) -> Tone {
    switch reason {
    case "approval", "manual_control": .attention
    case "runner_off", "unknown": .attention
    default: .neutral
    }
}

/// The server's delivery note in plain words (the chat footer and its explanation). The server writes these for the
/// web too, so the app rewrites only the phrases that read like a system log; anything else is shown as is.
func plainDeliveryNote(_ note: String) -> String {
    let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let exhausted = "몇 번 다시 넣어 봤지만 들어가지 않았습니다. '다시 보내기'를 눌러 주세요."
    if text.hasPrefix("자동 재전송 상한에 도달") || text.hasPrefix("자동 재시도로 해결 안 됨") { return exhausted }
    if text.hasPrefix("미전달을 확인했습니다") { return "아직 들어가지 않은 것을 확인했습니다. 안전한지 확인한 뒤 다시 넣습니다." }
    if text.hasPrefix("입력 제출을 확인 중") { return "입력칸에 넣은 글이 제출됐는지 확인하는 중입니다." }
    return text
        .replacingOccurrences(of: "CLI의 대화 연결", with: "AI 프로그램의 대화 연결")
        .replacingOccurrences(of: "이 실행기에서는", with: "이 실행 방식에서는")
        .replacingOccurrences(of: "세션 기록", with: "대화 기록")
}

