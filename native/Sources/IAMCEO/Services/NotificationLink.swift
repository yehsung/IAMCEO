import Foundation
import CoreFoundation
import Observation

/// External metadata is an untrusted hint. The host must revalidate its target before navigation.
struct NotificationLink: Sendable, Equatable {
    let serverID: String
    let eventID: String?
    let kind: String?
    let target: PushTarget
    /// 0.2.11: cli_update 알림의 CLI(target.cli). 누르면 그 CLI 의 확인 창까지 띄운다. 다른 알림은 nil.
    var updateCLI: String? = nil

    init?(url: URL) {
        guard let parsed = Self.parse(url: url) else { return nil }
        self = parsed
    }

    private init(serverID: String, eventID: String?, kind: String?, target: PushTarget) {
        self.serverID = serverID.lowercased(); self.eventID = eventID?.lowercased(); self.kind = kind; self.target = target
    }

    static func parse(url: URL) -> NotificationLink? {
        guard url.absoluteString.utf8.count <= 2048,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "iamceo", parts.host == "open", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { return nil }
        let encoded = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard encoded.count == 6, encoded[0].isEmpty else { return nil }
        let path = encoded.dropFirst().compactMap { String($0).removingPercentEncoding }
        guard path.count == 5, uuid(path[0]), path[1] == "projects", identifier(path[2]), identifier(path[4]) else { return nil }
        let target: PushTarget
        switch path[3] {
        case "decisions": target = .inbox(projectId: path[2], decisionId: path[4])
        case "members": target = .team(projectId: path[2], memberId: path[4])
        case "chat": target = .chat(projectId: path[2], memberId: nil, messageId: path[4])
        default: return nil
        }
        return NotificationLink(serverID: path[0], eventID: nil, kind: nil, target: target)
    }

    static func parse(payload: [AnyHashable: Any]) -> NotificationLink? {
        guard let object = payload["iamceo"] as? [String: Any], JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return parse(metadata: data)
    }

    static func parse(metadata: Data) -> NotificationLink? {
        guard metadata.count <= 8192,
              let object = (try? JSONSerialization.jsonObject(with: metadata)) as? [String: Any],
              Set(object.keys) == ["v", "serverId", "eventId", "kind", "target"],
              let version = object["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let value = try? JSONDecoder().decode(PushNotificationMetadata.self, from: metadata),
              value.v == 1, uuid(value.serverId), uuid(value.eventId),
              let targetObject = object["target"] as? [String: Any] else { return nil }
        // 0.2.11: CLI 새 판(cli_update)의 target 은 {screen:"home", cli, version} 세 열쇠다. 누르면 설정 › 실행 환경을 연다.
        let validTarget = value.kind == "cli_update" ? value.target == .home && cliUpdateTarget(targetObject) : valid(value.target, keys: Set(targetObject.keys))
        guard validTarget else { return nil }
        switch (value.kind, value.target) {
        case ("test", .home), ("decision", .inbox), ("approval_wait", .team), ("error", .team), ("report_complete", .chat),
             ("todo_created", .projectHome), ("report_blocked", .chat), ("cli_update", .home): break
        default: return nil
        }
        var link = NotificationLink(serverID: value.serverId, eventID: value.eventId, kind: value.kind, target: value.target)
        if value.kind == "cli_update" { link.updateCLI = targetObject["cli"] as? String }
        return link
    }

    private static func valid(_ target: PushTarget, keys: Set<String>) -> Bool {
        switch target {
        case .home: return keys == ["screen"]
        case .projectHome(let project): return keys == ["screen", "projectId"] && identifier(project)
        case .inbox(let project, let decision):
            return keys == ["screen", "projectId", "decisionId"] && identifier(project) && identifier(decision)
        case .team(let project, let member):
            return keys == ["screen", "projectId", "memberId"] && identifier(project) && identifier(member)
        case .chat(let project, let member, let message, let group):
            return keys.isSubset(of: ["screen", "projectId", "memberId", "messageId", "groupId"])
                && keys.isSuperset(of: ["screen", "projectId", "messageId"])
                && identifier(project) && identifier(message) && (member.map(identifier) ?? true) && (group.map(uuid) ?? true)
        case .unknown: return false
        }
    }
    /// cli_update 의 target: 열쇠가 정확히 screen·cli·version 이고, cli 는 이 앱이 아는 CLI, version 은 숫자.숫자.숫자[-…] 40자 이하.
    static func cliUpdateTarget(_ object: [String: Any]) -> Bool {
        guard Set(object.keys) == ["screen", "cli", "version"], object["screen"] as? String == "home",
              let cli = object["cli"] as? String, ["claude", "codex", "gemini"].contains(cli),
              let version = object["version"] as? String, version.utf8.count <= 40 else { return false }
        return version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\z"#, options: .regularExpression) != nil
    }
    private static func uuid(_ text: String) -> Bool {
        text.utf8.count == 36 && UUID(uuidString: text) != nil
    }
    private static func identifier(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.count <= 200 && text.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
}

/// App-scoped mailbox survives cold start and lets only one scene consume each tap.
/// Project selection/reset and authoritative target validation belong to the W8 navigation coordinator.
@MainActor @Observable
final class NotificationInbox {
    static let shared = NotificationInbox()
    private(set) var pending: [NotificationLink] = []
    private(set) var refreshRevision = 0
    @ObservationIgnored private var recent: [String] = []

    func receive(_ link: NotificationLink, tapped: Bool) {
        guard tapped else { refreshRevision &+= 1; return }
        if let event = link.eventID {
            let key = "\(link.serverID):\(event)"
            guard !recent.contains(key) else { return }
            recent.append(key)
            if recent.count > 100 { recent.removeFirst(recent.count - 100) }
        }
        pending.append(link)
        if pending.count > 100 { pending.removeFirst(pending.count - 100) }
    }

    /// A foreign server never changes endpoints or consumes the current host's pending route.
    func consume(serverID: String) -> NotificationLink? {
        guard let first = pending.first, first.serverID == serverID.lowercased() else { return nil }
        return pending.removeFirst()
    }
    func discardPending() { pending = [] }
}
