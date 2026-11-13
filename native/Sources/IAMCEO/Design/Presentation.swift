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
    switch kind { case "conductor": String(localized: "총괄"); case "root": String(localized: "본사 AI"); case "worker": String(localized: "팀장"); default: kind }
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
        case "network_outage":
            label = String(localized: "인터넷 끊김으로 멈춤"); tone = .attention; icon = "wifi.slash"; live = false; needsMe = false
            explanation = String(localized: "인터넷 연결이 돌아오면 자동으로 이어 갑니다.")
        case "network_retry":
            label = String(localized: "네트워크 재시도 중"); tone = .attention; icon = "arrow.clockwise"; live = false; needsMe = false
            explanation = String(localized: "네트워크 연결을 다시 확인하고 있습니다.")
        case "usage_limit":
            label = String(localized: "사용 한도 도달"); tone = .attention; icon = "hourglass"; live = false; needsMe = true
            explanation = String(localized: "한도가 풀리면 자동으로 이어 갑니다. 다른 모델로 바꾸면 바로 이어 갑니다.")
        case "unknown":
            label = String(localized: "상태 확인 불가"); tone = .attention; icon = "questionmark.circle"; live = false; needsMe = false
            explanation = String(localized: "지금 상태를 확인하지 못했습니다.")
        case "working":
            label = String(localized: "일하는 중"); tone = .live; icon = "bolt.fill"; live = true; needsMe = false
            explanation = String(localized: "지금 일을 처리하고 있습니다. 뒤에서 도는 작업을 기다리는 동안도 일하는 중으로 봅니다.")
        case "waiting":
            label = String(localized: "내 답 기다림"); tone = .attention; icon = "hourglass"; live = false; needsMe = true
            explanation = String(localized: "답하지 않은 결재가 있습니다. 답을 기다리는 동안 다른 일을 계속할 수도 있습니다.")
        case "blocked":
            label = String(localized: "승인 창 앞"); tone = .approval; icon = "hand.raised.fill"; live = false; needsMe = true
            explanation = String(localized: "승인이나 선택을 묻는 창 앞에서 멈췄습니다. 결재함이나 터미널에서 골라 주세요.")
        case "idle":
            label = String(localized: "쉬는 중"); tone = .neutral; icon = "pause.circle"; live = false; needsMe = false
            explanation = String(localized: "다음 지시를 기다립니다. 맡은 일이 끝났는지는 보고로 확인하세요.")
        case "asleep":
            label = String(localized: "잠듦"); tone = .dim; icon = "moon.zzz"; live = false; needsMe = false
            explanation = String(localized: "세션을 내려 두었습니다. 기록은 남아 있고, 깨우거나 지시를 보내면 다시 엽니다.")
        case "offline":
            label = String(localized: "안 보임"); tone = .dim; icon = "eye.slash"; live = false; needsMe = false
            explanation = String(localized: "실행 중인 화면을 찾지 못했습니다. 새 지시가 오면 다시 엽니다.")
        case "error":
            label = String(localized: "오류"); tone = .danger; icon = "exclamationmark.triangle.fill"; live = false; needsMe = true
            explanation = String(localized: "일을 시작하거나 이어 가다 실패했습니다. 오류 내용을 보고 깨우거나 새로 시작하세요.")
        default:
            label = status; tone = .neutral; icon = "questionmark.circle"; live = false; needsMe = false
            explanation = String(localized: "알 수 없는 상태입니다.")
        }
    }

    /// Display order for summaries (most urgent first).
    static let order = ["blocked", "waiting", "error", "working", "idle", "offline", "asleep"]
    static func rank(_ status: String) -> Int { order.firstIndex(of: status) ?? order.count }

    static func isNetworkPause(_ code: String?) -> Bool {
        ["network_outage", "network_retry", "usage_limit"].contains(code ?? "")
    }

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

    static let networkPauseCodes = ["network_outage", "network_retry", "usage_limit"]
    /// 인터넷 끊김·사용 한도로 멈춘 직원은 이유를 아는 대기다. '상태 확인 불가'로 세지 않고 그 이유로 묶는다(배지와 같은 판정).
    static func summaryCounts(_ members: [Member]) -> [String: Int] {
        Dictionary(grouping: members, by: { member in
            if member.statusObservation?.ownership != "conflict", let code = member.statusObservation?.error?.code, isNetworkPause(code) { return code }
            return isUncertain(member) ? "unknown" : member.status
        }).mapValues(\.count)
    }

    static func progressNote(_ member: Member, now: Date = Date()) -> String? {
        guard isProgressAdvisory(member.statusObservation?.error?.code), !observationUnavailable(member) else { return nil }
        let run = member.executionState
        let since = run?.lastProgressAt ?? run?.startedAt ?? run?.inputReceivedAt
        let date = parseISODate(since)
        if let date {
            let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
            return String(localized: "화면 출력 없이 \(minutes)분째 진행 중")
        }
        return String(localized: "화면 출력 없이 진행 중입니다. 일하는 중인 것은 확인됩니다.")
    }

    /// Prefer this overload when the server supplies observation metadata.
    init(_ member: Member) {
        let observation = member.statusObservation
        if observation?.ownership == "conflict" {
            self.init(label: String(localized: "소유 관계 확인 필요"), tone: .attention, icon: "lock.trianglebadge.exclamationmark",
                      explanation: String(localized: "이 팀원의 화면을 다른 곳에서도 잡고 있어 마지막 상태만 보여 줍니다. 자동 전달은 멈춰 둡니다."), needsMe: true)
        } else if let code = observation?.error?.code, Self.isNetworkPause(code) {
            self = Self(code)
        } else if let guide = BlockedGuide(member), !member.hasFolderTrustApproval {
            // The server said why it is stuck: say that and point at the terminal, instead of "상태 확인 불가".
            self.init(label: guide.label, tone: .attention, icon: "terminal", explanation: guide.explanation, needsMe: true)
        } else if Self.observationUnavailable(member) {
            self.init(label: String(localized: "상태 확인 불가"), tone: .attention, icon: "questionmark.circle",
                      explanation: observation?.error?.note ?? String(localized: "지금 상태를 읽지 못했습니다. 마지막으로 본 상태를 보여 주며 다시 확인하고 있습니다."))
        } else if member.status == "blocked", !["permission", "selection"].contains(member.blockedReason ?? ""), !member.hasFolderTrustApproval {
            self.init(label: member.blockedReason == "setup" ? String(localized: "상태 설정 확인 중") : String(localized: "상태 확인 불가"),
                      tone: .attention, icon: "questionmark.circle", explanation: String(localized: "승인 창인지 아직 확인하지 못했습니다. 다시 확인하는 동안 자동 전달은 멈춰 둡니다."))
        } else if member.origin == "manual" {
            let base = Self(member.status)
            self.init(label: String(localized: "\(base.label) · 추정"), tone: base.tone, icon: base.icon,
                      explanation: String(localized: "마지막 활동으로 짐작한 상태입니다. 실제로 일하는지는 확인하지 못했습니다."), needsMe: base.needsMe)
        } else if !Self.order.contains(member.status) {
            self.init(label: String(localized: "상태 확인 불가"), tone: .neutral, icon: "questionmark.circle", explanation: String(localized: "알 수 없는 상태입니다. 잠시 뒤 다시 확인합니다."))
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

/// A blocked member whose server gave a reason code this app knows: what to tell the owner and what the terminal
/// button says. Unknown or missing codes give nil, and the member is shown exactly as before.
struct BlockedGuide: Sendable, Equatable {
    static let openTerminal = String(localized: "터미널 열기")
    let label: String
    let explanation: String
    let actionTitle: String

    init?(_ member: Member) {
        guard member.status == "blocked" else { return nil }
        switch member.blockedCode {
        case "trust_dialog_unrecognized":
            label = String(localized: "폴더 신뢰 확인 필요")
            // Named after the session's own CLI, as the first-run choice names them; an unknown kind is left unnamed
            // rather than called Claude Code.
            let cli = ["claude": "Claude Code", "codex": "Codex"][member.cli]
            explanation = (cli.map { String(localized: "\($0)\(subjectParticle($0)) 이 폴더를 신뢰할지 묻고 있습니다.") } ?? String(localized: "이 폴더를 신뢰할지 묻는 창이 떠 있습니다."))
                + String(localized: " 터미널에서 직접 답해 주세요.")
            actionTitle = String(localized: "터미널 열어 직접 답하기")
        case "start_not_ready":
            label = String(localized: "시작 지연")
            explanation = String(localized: "시작이 늦어지고 있습니다. 터미널을 열어 상태를 확인해 주세요.")
            actionTitle = Self.openTerminal
        default: return nil
        }
    }
}

/// The execution engine line of the status strips. Only the two states the server names; anything else is silent.
struct EngineNotice: Sendable, Equatable {
    let text: String
    init?(_ engine: EngineState?) {
        switch engine?.state {
        case "unresponsive": text = String(localized: "실행 엔진이 응답하지 않습니다. Mac에서 IAMCEO를 다시 시작해 주세요.")
        case "version_mismatch": text = String(localized: "실행 엔진 버전이 맞지 않습니다. IAMCEO를 최신 버전으로 다시 설치해 주세요.")
        default: return nil
        }
    }
}

/// Tailscale is off on the server's Mac: the iPhone cannot reach it while this Mac still can (over 127.0.0.1).
/// Only the Mac app on that Mac says so, as a status strip and as one Mac notification per off period. An iPhone
/// that reaches the server has a working path, so it stays silent. Only "off" speaks.
struct TailnetNotice: Sendable, Equatable {
    static let stripText = String(localized: "Tailscale이 꺼져 있어 iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.")
    /// The Mac notification. The server's own script notification says the same with an "IAMCEO · " prefix
    /// (server/tailnet.ts); the app's banner already carries the app name.
    static let notificationTitle = String(localized: "Tailscale이 꺼져 있습니다")
    static let notificationBody = String(localized: "iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.")

    let text: String
    init?(_ tailnet: TailnetState?, onThisMac: Bool) {
        guard onThisMac, tailnet?.state == "off" else { return nil }
        text = Self.stripText
    }
}

/// One Mac notification per off period. A period is named by the server and the time its address went missing,
/// so a reconnect or a re-read of the same period stays quiet; a period with no time ends when "ok" is heard.
struct TailnetOffTracker: Sendable, Equatable {
    private var notified: String?

    /// `appOwnsNotifications`: the Mac app posts notifications itself right now. While it does not, the period
    /// stays open, so it is announced once the app does (unless the server already announced it).
    mutating func shouldNotify(_ tailnet: TailnetState?, serverID: String, appOwnsNotifications: Bool) -> Bool {
        switch tailnet?.state {
        case "off":
            let period = serverID + "|" + (tailnet?.since ?? "")
            guard appOwnsNotifications, tailnet?.macNotified != true, notified != period else { return false }
            notified = period
            return true
        case "ok":
            notified = nil
            return false
        default:
            return false
        }
    }
}

/// How sessions may run commands. Settings and the first-run choice use the same three names.
struct PermissionModeChoice: Identifiable, Sendable, Equatable {
    let id: String
    let title: String
    let detail: String
    var badge: String? = nil

    static let bypass = "bypassPermissions"
    /// Settings › 일반 › 권한.
    static let settings = [
        PermissionModeChoice(id: bypass, title: String(localized: "묻지 않기"), detail: String(localized: "팀장이 승인 창 없이 명령을 실행합니다"), badge: String(localized: "기본")),
        PermissionModeChoice(id: "auto", title: String(localized: "위험할 때만 묻기"), detail: String(localized: "위험해 보이는 작업만 멈추고 묻습니다")),
        PermissionModeChoice(id: "default", title: String(localized: "매번 묻기"), detail: String(localized: "도구를 쓸 때마다 승인을 기다립니다"))
    ]
    /// The first-run choice: the same three, with 묻지 않기 spelled out because it is the one picked to begin with.
    static let firstRun = settings.map { choice in
        choice.id == bypass
            ? PermissionModeChoice(id: choice.id, title: choice.title,
                                   detail: String(localized: "승인 창에서 멈추지 않고 맡긴 일을 끝까지 합니다. 잘못된 명령도 묻지 않고 실행됩니다."), badge: choice.badge)
            : choice
    }
    static let firstRunTitle = String(localized: "팀장이 명령을 실행하는 방식")
    /// `onThisMac`: the Mac app on the server's own Mac. An iPhone or a remote Mac says "연결된 Mac".
    static func firstRunLead(onThisMac: Bool) -> String {
        String(localized: "팀장은 \(onThisMac ? String(localized: "이 Mac") : String(localized: "연결된 Mac"))에서 Claude Code·Codex로 명령을 실행합니다. 파일을 고치고 지우는 일, 프로그램 설치, git 명령이 포함됩니다. 어떻게 실행할지 골라 주세요. 설정에서 언제든 바꿀 수 있습니다.")
    }
    static let firstRunConfirm = String(localized: "이대로 시작")
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
                label = String(localized: "서브에이전트 \(value)개") + (member.subagentState?.quality == "estimated" ? String(localized: " · 추정") : "")
            } else { count = nil; label = String(localized: "서브에이전트 수 확인 불가") }
        case "unsupported": count = nil; label = String(localized: "서브에이전트 수 미지원")
        default: count = nil; label = String(localized: "서브에이전트 수 미수집")
        }
    }
}

struct LastReportInfo: Sendable {
    let label = String(localized: "마지막 보고")
    let text: String
    let reportedAt: String?
    let next: String
    init(_ member: Member) {
        text = member.now.isEmpty ? String(localized: "아직 보고가 없습니다") : member.now
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
            label = String(localized: "전달 대기"); tone = .neutral; icon = "clock"
            explanation = String(localized: "저장했습니다. 받는 사람 차례가 되면 넣습니다.")
        case "held":
            label = String(localized: "보류"); tone = .attention; icon = "pause.circle"
            explanation = String(localized: "자동 전달을 멈췄습니다. 이유를 확인하고 해결하면 다시 전달합니다.")
        case "delivering":
            label = String(localized: "넣는 중"); tone = .neutral; icon = "arrow.up.circle"
            explanation = String(localized: "받는 사람 입력칸에 넣는 중입니다.")
        case "delivered":
            label = String(localized: "받음"); tone = .success; icon = "checkmark.circle"
            explanation = String(localized: "받는 사람에게 들어갔습니다. 일을 끝냈다는 뜻은 아닙니다.")
        case "failed":
            label = String(localized: "실패"); tone = .danger; icon = "exclamationmark.circle"
            explanation = String(localized: "받는 사람에게 넣지 못했습니다. 같은 글을 다시 보낼 수 있습니다.")
        case "dismissed":
            label = String(localized: "정리함"); tone = .dim; icon = "minus.circle"
            explanation = String(localized: "보내지 않고 정리했습니다. 필요하면 새로 써서 보내 주세요.")
        default:
            label = delivery; tone = .neutral; icon = "questionmark.circle"; explanation = ""
        }
    }

    init(_ item: DeliveryNoticeItem) {
        switch item.phase {
        case .checking:
            self.init(label: String(localized: "전달 확인 중"), tone: .neutral, icon: "magnifyingglass", explanation: String(localized: "받았는지 시스템이 확인하고 있습니다."))
        case .retryWait:
            self.init(label: String(localized: "자동 재전송 대기"), tone: .neutral, icon: "arrow.clockwise", explanation: String(localized: "안전한지 다시 확인한 뒤 자동으로 넣습니다. 아직 받은 것은 아닙니다."))
        case .needsOwner:
            self.init(label: String(localized: "전달 확인 필요"), tone: .attention, icon: "exclamationmark.circle", explanation: item.reasonDescription)
        case .waiting:
            self.init(label: String(localized: "전달 대기"), tone: .neutral, icon: "clock", explanation: item.reasonDescription)
        case .stopped:
            self.init(label: String(localized: "추가 전달 중지"), tone: .dim, icon: "pause.circle", explanation: String(localized: "추가 전달을 중지했습니다. 과거 수신 여부는 알 수 없습니다."))
        case .resolved where item.status == "delivered":
            self.init(label: String(localized: "받음"), tone: .success, icon: "checkmark.circle", explanation: String(localized: "받는 사람에게 들어갔습니다. 일을 끝냈다는 뜻은 아닙니다."))
        case .some(.none) where item.reason == "not_received":
            self.init(label: item.status == "held" ? String(localized: "입력 확인 대기") : String(localized: "전달 대기"), tone: .neutral, icon: "clock", explanation: item.reasonDescription)
        case .some(.none):
            self = Self(item.status) ?? Self(label: String(localized: "전달 상태 확인 불가"), tone: .neutral, icon: "questionmark.circle", explanation: String(localized: "최신 전달 근거를 다시 확인해 주세요."))
        default:
            self.init(label: String(localized: "전달 상태 확인 불가"), tone: .neutral, icon: "questionmark.circle", explanation: String(localized: "최신 전달 근거를 다시 확인해 주세요."))
        }
    }

    init(_ summary: MemberDeliverySummary) {
        if summary.needsOwnerCount > 0 {
            self.init(label: String(localized: "전달 확인 \(Self.badgeCount(summary.needsOwnerCount))"), tone: .attention,
                      icon: "exclamationmark.circle", explanation: String(localized: "전달 확인이 필요한 항목 \(summary.needsOwnerCount)건입니다."))
        } else if summary.checkingCount > 0 || summary.unknownCount > 0 {
            self.init(label: String(localized: "전달 확인 중"), tone: .neutral, icon: "magnifyingglass", explanation: String(localized: "시스템이 수신 근거를 확인하고 있습니다. 대표의 수신 판정은 필요하지 않습니다."))
        } else if summary.deliveringCount > 0 {
            self.init(label: String(localized: "전달 중"), tone: .neutral, icon: "arrow.up.circle", explanation: String(localized: "넣는 중입니다. 아직 받은 것은 아닙니다."))
        } else {
            self.init(label: summary.undeliveredCount > 0 ? String(localized: "전달 대기") : String(localized: "전달 문제 없음"), tone: .neutral, icon: "clock", explanation: String(localized: "미전달 \(max(0, summary.undeliveredCount))건 · 뒤에서 대기 \(max(0, summary.waitingBehindCount))건"))
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
    let parts = [(String(localized: "미확인"), summary.unknownCount),
                 (String(localized: "미전달"), summary.undeliveredCount),
                 (String(localized: "뒤에서 대기"), summary.waitingBehindCount)]
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
        case "claude_log": sourceLabel = String(localized: "Claude 주 세션 입력 기록")
        case "codex_log": sourceLabel = String(localized: "Codex 주 세션 입력 기록")
        case "transport": sourceLabel = String(localized: "터미널 응답")
        case "core_screen", "herdr_screen": sourceLabel = evidence.location == "composer" ? String(localized: "입력칸") : String(localized: "터미널 화면")
        default: sourceLabel = String(localized: "전달 근거")
        }
        switch evidence.verdict {
        case .present:
            label = String(localized: "확인됨")
            if evidence.location == "composer" {
                detail = String(localized: "입력칸의 내용을 확인했습니다. CLI가 입력을 받았다는 뜻은 아닙니다.")
            } else {
                detail = String(localized: "해당 위치에서 근거를 확인했습니다. 업무 완료를 뜻하지 않습니다.")
            }
        case .absent where evidence.complete: label = String(localized: "해당 없음"); detail = String(localized: "완전하게 확인한 범위에 근거가 없습니다. 이것만으로 미수신을 확정하지 않습니다.")
        default: label = String(localized: "취득 불가"); detail = String(localized: "근거를 완전하게 확인하지 못했습니다. 미수신을 뜻하지 않습니다.")
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
            label = decision.options.isEmpty ? String(localized: "답변 요청") : String(localized: "선택 요청"); tone = .attention
        case "answered":
            label = String(localized: "답함 · 전달 대기"); tone = .neutral
        case "delivered":
            label = String(localized: "답함 · 담당자가 받음"); tone = .success
        case "closed":
            label = String(localized: "닫힘"); tone = .dim
        default:
            label = decision.status; tone = .neutral
        }
    }
}

func closeKindName(_ kind: String?) -> String? {
    switch kind {
    case "decided": String(localized: "대표가 이미 정함")
    case "obsolete": String(localized: "필요 없어짐")
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
    case "text": String(localized: "글"); case "tool": String(localized: "도구"); case "tool_result": String(localized: "결과"); case "turn_start": String(localized: "시작")
    case "turn_end": String(localized: "끝"); case "compact": String(localized: "압축"); case "error": String(localized: "오류"); case "system": String(localized: "알림")
    default: kind
    }
}

enum WorkSection: String, CaseIterable, Identifiable, Sendable {
    case doing, next, hold, done
    var id: String { rawValue }
    var title: String { switch self { case .doing: String(localized: "진행 중"); case .next: String(localized: "예정"); case .hold: String(localized: "보류"); case .done: String(localized: "완료") } }
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
    ServerCode.deliveryUnknownHold(message)
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
    if !project.connection.ok { parts.append(String(localized: "연결 문제")) }
    if project.decisionCount > 0 { parts.append(String(localized: "결재 \(project.decisionCount)")) }
    if project.todoCount > 0 { parts.append(String(localized: "할 일 \(project.todoCount)")) }
    if project.blockedCount > 0 { parts.append(String(localized: "승인 창 앞 \(project.blockedCount)명")) }
    if project.errorCount > 0 { parts.append(String(localized: "오류 \(project.errorCount)명")) }
    if project.workingCount > 0 { parts.append(String(localized: "\(project.workingCount)명 일하는 중")) }
    return parts.isEmpty ? String(localized: "개입할 일 없음") : parts.joined(separator: " · ")
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
/// `code`: 그 문장과 짝인 서버 코드(팀장의 fenceCode, 응답의 code·reason). 코드가 있으면 코드로 고르고(4차 R),
/// 없는 옛 서버에서는 예전처럼 문장으로 가른다. 한국어 화면의 결과는 예전과 같다.
func friendlyError(_ raw: String) -> String { friendlyError(raw, code: nil) }
func friendlyError(_ raw: String, code: String?) -> String {
    if code == "starting_unknown" { return String(localized: "세션을 시작했는지 아직 확인하지 못했습니다. 상태를 다시 확인하고 있습니다.") }
    var text = ServerErrorText.display(raw.trimmingCharacters(in: .whitespacesAndNewlines), code: code)
    // The server appends the raw socket detail, e.g. "(hello: connect ENOENT /private/…/core.sock)". The Korean lead says it all.
    if let range = text.range(of: #"\s*\([^()]*(ENOENT|ECONNREFUSED|ETIMEDOUT|hello:|connect )[^()]*\)\s*$"#, options: [.regularExpression, .caseInsensitive]) {
        text.removeSubrange(range)
    }
    // 접속 코드 거절(401)의 서버 대표 문장은 그대로 둔다. 영어 문장 "Authentication required…"가 아래의 AI 로그인 판정에
    // 걸리지 않게 한다(4차 리뷰 ui-6). 한국어 문장은 원래 어느 판정에도 걸리지 않아 결과가 같다.
    if ConnectionRecovery.unauthorizedCodes.contains(where: { ServerErrorText.matches(text, code: $0) }) { return text }
    let lower = text.lowercased()
    func has(_ needle: String) -> Bool { lower.contains(needle.lowercased()) }
    if has("can't use your claude subscription") || has("payment is past due") {
        return String(localized: "Claude 구독 결제에 문제가 있어 일을 할 수 없습니다. claude.ai 설정에서 결제를 확인해 주세요.")
    }
    if has("no response from api") || has("overloaded") || has("api error: 5") {
        return String(localized: "AI 서버가 응답하지 않습니다. 잠시 뒤 다시 시도합니다.")
    }
    if has("usage limit") || has("rate limit") || has("사용 한도") || has("limit reached") {
        return String(localized: "사용 한도에 닿았습니다. 한도가 풀리면 자동으로 이어 갑니다. 다른 모델로 바꾸면 바로 이어 갑니다.")
    }
    if has("not logged in") || has("please run /login") || has("authentication") || has("unauthorized") {
        return String(localized: "AI 계정 로그인이 풀렸습니다. Mac 터미널에서 다시 로그인해 주세요.")
    }
    if has("starting_unknown") { return String(localized: "세션을 시작했는지 아직 확인하지 못했습니다. 상태를 다시 확인하고 있습니다.") }
    if has("cli reported an error") { return String(localized: "AI 프로그램이 오류를 알렸습니다. 터미널에서 내용을 확인해 주세요.") }
    if text.contains("턴이 시작되지 않았습니다") { return text.replacingOccurrences(of: "턴이 시작되지 않았습니다", with: "일을 시작하지 않았습니다") }
    if let range = text.range(of: #"\(?exit(_code)?[ =]?(\d+)\)?"#, options: .regularExpression) {
        let code = text[range].filter(\.isNumber)
        let rest = text.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lead = rest.isEmpty ? String(localized: "프로그램이 비정상 종료됐습니다") : rest
        return String(localized: "\(lead) (종료 코드 \(code))")
    }
    return text
}

/// Why a file, page or preview could not be fetched, in words the CEO can act on (A-78): never "Request failed (502)."
/// or an English system string. `what` names the thing ("원본", "페이지"), `verb` the action ("받지", "읽지", "올리지").
/// A Korean server message is kept as is.
/// 영어 화면: `what`·`verb` 조각은 loadErrorNoun·loadErrorVerb 가 영어 낱말로 바꾸고, 문장 틀은 문구 표의 번역을 쓴다.
func friendlyLoadError(_ error: Error, what: String = "원본", verb: String = "받지") -> String {
    let what = loadErrorNoun(what)
    let verb = loadErrorVerb(verb)
    let object = "\(what)\(objectParticle(what))"
    let subject = "\(what)\(subjectParticle(what))"
    if let failure = error as? ChatHistoryFailure {
        switch failure {
        case .invalidPage: return String(localized: "대화 기록을 확인하지 못했습니다. 다시 불러오기를 눌러 주세요.")
        case .storeChanged: return String(localized: "서버의 대화 기록이 변경되었습니다")
        }
    }
    if let api = error as? APIError {
        switch api.status {
        case 401, 403: return String(localized: "접근이 거절됐습니다. 설정에서 연결을 다시 확인해 주세요.")
        case 404, 410: return String(localized: "\(subject) 서버에 없습니다. 지워졌거나 옮겨졌을 수 있습니다.")
        case 413: return String(localized: "\(subject) 너무 커서 앱에서 열 수 없습니다.")
        case 500...599: return String(localized: "서버 문제로 \(object) \(verb) 못했습니다. 잠시 뒤 다시 시도해 주세요.")
        default:
            let message = api.message.trimmingCharacters(in: .whitespacesAndNewlines)
            // 영어 화면: 코드의 영어 문장이 있으면 그것(ServerErrorDisplay). 한국어 화면은 아래 줄 그대로.
            let shown = ServerErrorText.display(message, code: api.code, reason: api.reason)
            if shown != message { return shown }
            if !message.contains("IAMCEO."), message.range(of: #"\p{Hangul}"#, options: .regularExpression) != nil { return message }
            // 영어 화면: 앱이 지은 영어 문장(주소 형식 안내 등)이나 이미 다듬은 까닭은 그대로 둔다(4차 리뷰 lang-1).
            // 상태 번호만 있는 "Request failed (…)"와 내부 형식 이름은 아래의 일반 문장으로.
            if keepsEnglishReason(message) { return message }
            return String(localized: "\(object) \(verb) 못했습니다.")
        }
    }
    if let url = error as? URLError {
        // C8: 이 기기의 Tailscale 이 꺼져 있어 앱이 스스로 보내지 않은 요청. 무엇을 켜야 하는지 그대로 말한다.
        if Tailnet.isOffError(url) { return Tailnet.offMessage }
        switch url.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return String(localized: "서버와 연결이 끊겨 \(object) \(verb) 못했습니다.")
        case .timedOut: return String(localized: "시간이 너무 오래 걸려 \(object) \(verb) 못했습니다. 다시 시도해 주세요.")
        case .cancelled: return String(localized: "멈췄습니다.")
        default: return String(localized: "\(object) \(verb) 못했습니다.")
        }
    }
    if error is DecodingError { return String(localized: "\(what) 내용을 읽지 못했습니다. 형식이 맞지 않습니다.") }
    // Foundation's synthesized description can contain a Korean wrapper around an internal type name.
    if let text = (error as? LocalizedError)?.errorDescription, !text.contains("IAMCEO."),
       text.range(of: #"\p{Hangul}"#, options: .regularExpression) != nil || keepsEnglishReason(text) { return friendlyError(text) }
    return String(localized: "\(object) \(verb) 못했습니다.")
}

/// 영어 화면에서 오류 문장을 그대로 보일까(4차 리뷰 lang-1). 한국어 화면은 늘 false 라 예전 판정 그대로다.
private func keepsEnglishReason(_ raw: String) -> Bool {
    guard AppLanguage.current == .en else { return false }
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return !text.isEmpty && !text.hasPrefix("Request failed (") && !text.contains("IAMCEO.")
        // Foundation 이 지어낸 "The operation couldn’t be completed. (X error 1.)" 는 읽을 수 없는 문장이다.
        && text.range(of: #"\([^()]* error -?\d+\.?\)"#, options: .regularExpression) == nil
}

/// 을/를 after a Korean word (by its last syllable's final consonant).
/// 영어 화면에는 조사가 없다(빈 글자).
func objectParticle(_ word: String) -> String { !appUsesParticles ? "" : hasFinalConsonant(word) ? "을" : "를" }
/// 이/가 — the subject form, same rule.
func subjectParticle(_ word: String) -> String { !appUsesParticles ? "" : hasFinalConsonant(word) ? "이" : "가" }
private func hasFinalConsonant(_ word: String) -> Bool {
    guard let scalar = word.unicodeScalars.last, (0xAC00...0xD7A3).contains(scalar.value) else { return false }
    return (scalar.value - 0xAC00) % 28 != 0
}

/// Why a delivery is still waiting, in the CEO's words (server `waitReason`, wave UX-T1), with how long it has waited.
/// Shared by the chat bubble's status line, 홈 and the member page: one wording everywhere.
/// `reason`: next_turn · run_limit · member_busy · waking · receipt_check · approval · manual_control · runner_off · archived
/// · api_outage · usage_limit · unknown (shared/types.ts DeliveryWaitReason).
/// `since`: ISO time the delivery started waiting. `used`/`limit`: the run-limit slots when reason is run_limit.
func waitReasonLabel(_ reason: String?, since: String? = nil, used: Int? = nil, limit: Int? = nil, now: Date = Date()) -> String? {
    guard let reason, !reason.isEmpty else { return nil }
    let base: String
    switch reason {
    case "run_limit":
        if let used, let limit, limit > 0 { base = String(localized: "동시에 일하는 팀원이 다 차서 차례를 기다리는 중(\(used)/\(limit))") }
        else { base = String(localized: "동시에 일하는 팀원이 다 차서 차례를 기다리는 중") }
    case "member_busy": base = String(localized: "지금 하던 일이 끝나면 전달")
    // A report or note that does not wake its reader: it goes in with that member's next turn, by design.
    case "next_turn": base = String(localized: "다음에 일할 때 함께 전달")
    case "waking": base = String(localized: "깨우는 중")
    case "receipt_check": base = String(localized: "앞 지시를 받았는지 확인하는 중")
    case "approval": base = String(localized: "승인 창 앞이라 대기 중")
    case "manual_control": base = String(localized: "터미널에서 직접 조작 중이라 대기")
    case "runner_off": base = String(localized: "이 프로젝트 실행이 꺼져 있어 대기")
    case "archived": base = String(localized: "보관한 프로젝트라 보내지 않음")
    // 서버가 일부러 붙잡아 둔 전달이다. 이유가 풀리면 저절로 나간다.
    case "api_outage": base = String(localized: "인터넷 연결이 돌아오면 전달")
    case "usage_limit": base = String(localized: "사용 한도가 풀리면 전달")
    case "retry_wait": base = String(localized: "잠시 뒤 다시 보내는 중")
    default: base = String(localized: "전달을 기다리는 중")
    }
    guard let since, let start = parseISODate(since) else { return base }
    let minutes = Int(now.timeIntervalSince(start) / 60)
    if minutes < 1 { return base }
    if minutes < 60 { return String(localized: "\(base) · \(minutes)분째") }
    let hours = minutes / 60
    return hours < 24 ? String(localized: "\(base) · \(hours)시간째") : String(localized: "\(base) · \(hours / 24)일째")
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
/// `code`: 서버가 메모와 함께 주는 보류 코드(Message.deliveryCode, held_*). 영어 화면은 코드의 영어 문장을 쓴다(4차 R).
/// 재전송·미전달 확인 메모에는 아직 코드가 없어 예전처럼 문장 머리로 가른다.
func plainDeliveryNote(_ note: String) -> String { plainDeliveryNote(note, code: nil) }
func plainDeliveryNote(_ note: String, code: String?) -> String {
    let text = ServerErrorText.display(note.trimmingCharacters(in: .whitespacesAndNewlines), code: code)
    let exhausted = String(localized: "몇 번 다시 넣어 봤지만 들어가지 않았습니다. '다시 보내기'를 눌러 주세요.")
    if text.hasPrefix("자동 재전송 상한에 도달") || text.hasPrefix("자동 재시도로 해결 안 됨") { return exhausted }
    if text.hasPrefix("미전달을 확인했습니다") { return String(localized: "아직 들어가지 않은 것을 확인했습니다. 안전한지 확인한 뒤 다시 넣습니다.") }
    if text.hasPrefix("입력 제출을 확인 중") { return String(localized: "입력칸에 넣은 글이 제출됐는지 확인하는 중입니다.") }
    return text
        .replacingOccurrences(of: "CLI의 대화 연결", with: "AI 프로그램의 대화 연결")
        .replacingOccurrences(of: "이 실행기에서는", with: "이 실행 방식에서는")
        .replacingOccurrences(of: "세션 기록", with: "대화 기록")
}


/// The app's own server connection takes precedence over the server's internet notice.
struct APIOutageInfo: Sendable {
    let text: String
    let tone: Tone = .attention

    init?(_ outage: APIOutage?, showsOffline: Bool) {
        guard let outage, !showsOffline else { return nil }
        text = String(localized: "인터넷 연결이 불안정합니다 · 팀원 \(Set(outage.affectedMemberIds).count)명 대기 중 · 돌아오면 자동으로 이어 갑니다")
    }
}

/// One button on a usage-limit card.
struct UsageLimitButton: Sendable, Equatable {
    let choice: String
    let label: String
    let primary: Bool
}

struct UsageLimitInfo: Sendable {
    /// Shipped iPhones (0.2.2, 0.2.3) answer with this key: never rename it.
    static let resumeChoice = "resume"
    /// `model:<value>`: switch the card's staff to that model and continue the same conversations.
    static let modelChoicePrefix = "model:"
    /// Used only when the server sends no options. Does not assume the person has another account.
    static let resumeLabel = String(localized: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기")
    static let stillLimitedText = String(localized: "아직 한도가 남아 있지 않습니다. 기다리거나 다른 모델을 고르세요.")
    /// Still limited and no model to pick (an account-wide limit, every model already limited, or an older server): waiting is the way.
    static let stillLimitedWaitText = String(localized: "아직 한도가 남아 있지 않습니다. 한도가 풀리면 자동으로 이어 갑니다.")
    let resumesText: String?
    let memberNames: [String]
    let warning: String?

    init(_ decision: Decision, members: [Member], timeZone: TimeZone = .current) {
        if let date = parseISODate(decision.usageLimit?.resetsAt) {
            let formatter = DateFormatter()
            let onTheHour = Calendar(identifier: .gregorian).dateComponents(in: timeZone, from: date).minute == 0
            formatter.locale = AppLanguage.current.dateLocale
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = timeZone
            if AppLanguage.current == .en {
                formatter.setLocalizedDateFormatFromTemplate(onTheHour ? "MMMdj" : "MMMdjmm")
            } else {
                formatter.dateFormat = "M월 d일 a h시" + (onTheHour ? "" : " m분")
            }
            resumesText = String(localized: "\(formatter.string(from: date))에 자동으로 이어 갑니다")
        } else { resumesText = nil }
        var seen = Set<String>()
        memberNames = (decision.usageLimit?.memberIds ?? []).filter { seen.insert($0).inserted }.map { id in
            members.first { $0.id == id }.map { $0.name.isEmpty ? id : $0.name } ?? id
        }
        // Say "pick another model" only when the card offers one: an account-wide limit (5-hour, weekly) has no model choices.
        let offersModel = Self.buttons(decision).contains { $0.choice.hasPrefix(Self.modelChoicePrefix) }
        warning = decision.usageLimit?.stillLimited == true ? (offersModel ? Self.stillLimitedText : Self.stillLimitedWaitText) : nil
    }

    /// The card's buttons in the server's order (models first, then `resume`). Waiting is not a button: the server continues on its own
    /// when the limit lifts. The first model choice is the prominent button, the rest are secondary. An older server sends only `resume`,
    /// which stays the one prominent button with the server's label, as before.
    static func buttons(_ decision: Decision) -> [UsageLimitButton] {
        let options = decision.options.filter { $0.k == resumeChoice || $0.k.hasPrefix(modelChoicePrefix) }
        guard !options.isEmpty else { return [UsageLimitButton(choice: resumeChoice, label: resumeLabel, primary: true)] }
        let primary = options.first { $0.k.hasPrefix(modelChoicePrefix) }?.k ?? options[0].k
        return options.map { option in
            UsageLimitButton(choice: option.k, label: option.label.isEmpty ? (option.k == resumeChoice ? resumeLabel : option.k) : option.label, primary: option.k == primary)
        }
    }

    /// The server recomputes a usage card's model choices (a member left, the model list changed) without moving `updatedAt`,
    /// which the card's push notification is keyed to. A shown card whose options differ from the latest is redrawn.
    static func optionsChanged(_ shown: Decision, latest: Decision?) -> Bool {
        guard shown.kind == "usage_limit", let latest else { return false }
        return latest.options != shown.options || latest.usageLimit?.memberIds != shown.usageLimit?.memberIds
    }

    /// What the inbox watches to redraw while it stays on screen (the Mac keeps the inbox tab up, so onAppear does not come back).
    /// A usage card's choices and staff change without `updatedAt`, so they are part of its signature; other cards are `id@updatedAt` as before.
    static func syncSignature(_ decision: Decision) -> String {
        let base = "\(decision.id)@\(decision.updatedAt)"
        guard decision.kind == "usage_limit" else { return base }
        return base + "/" + decision.options.map(\.k).joined(separator: ",") + "/" + (decision.usageLimit?.memberIds ?? []).joined(separator: ",")
    }

    /// A choice this card can be answered with: `resume`, or one of the model choices the server offered on it.
    static func accepts(_ decision: Decision, choice: String?) -> Bool {
        guard let choice else { return false }
        return choice == resumeChoice || (choice.hasPrefix(modelChoicePrefix) && decision.options.contains { $0.k == choice })
    }

    /// Stable partition: preserve the existing priority within each kind.
    static func prioritized(_ decisions: [Decision]) -> [Decision] {
        decisions.filter { $0.kind == "usage_limit" } + decisions.filter { $0.kind != "usage_limit" }
    }
}

/// Why the member settings must not reopen the session now (the server refuses with 409 mid-turn or at an approval window).
/// A member stopped by a usage-limit menu is not at an approval window: the server closes that menu with Esc only and continues the
/// same conversation on the new model, and the status line tells the person to change the model. `reopens`: the change restarts the session.
func memberReopenBlock(_ member: Member, reopens: Bool) -> String? {
    guard reopens else { return nil }
    if member.status == "working" || (member.status == "blocked" && member.blockedReason != "usage_limit") {
        return String(localized: "일하거나 승인 창 앞이면 세션을 다시 열 수 없습니다. 턴이 끝난 뒤 적용하세요.")
    }
    return nil
}
