import Foundation
import Observation

struct MacNotificationEvent: Sendable, Equatable {
    let kind: String
    let sourceID: String
    let target: PushTarget
    var title: String {
        switch kind {
        case "decision": "새 결재가 있습니다"
        case "approval_wait": "직원이 승인·선택을 기다립니다"
        case "report_complete": "완료 보고가 도착했습니다"
        case "report_blocked": "막힘 보고가 도착했습니다"
        default: "대표님이 할 일이 있습니다"
        }
    }
}

/// Only new events notify. Initial snapshots, repeated changes and our own messages stay quiet.
struct MacNotificationTracker {
    private var decisions: [String: String] = [:]
    private var members: [String: String] = [:]
    private var todos: Set<String> = []
    private var reports: Set<String> = []
    private var reportOrder: [String] = []

    mutating func seed(_ state: ProjectState) {
        for decision in state.decisions { decisions[key(state.project.id, decision.id)] = decision.status }
        for member in state.members { members[key(state.project.id, member.id)] = approvalState(member) }
        for todo in state.todos { todos.insert(key(state.project.id, todo.id)) }
        for message in state.messages { rememberReport(key(state.project.id, message.id)) }
    }

    mutating func event(_ event: RealtimeEvent) -> MacNotificationEvent? {
        if let decision = event.decision {
            let id = key(decision.projectId, decision.id), previous = decisions[id]
            decisions[id] = decision.status
            if decision.status == "open", previous != "open" {
                return MacNotificationEvent(kind: "decision", sourceID: decision.id,
                                            target: .inbox(projectId: decision.projectId, decisionId: decision.id))
            }
        }
        if let member = event.member {
            let id = key(member.projectId, member.id), current = approvalState(member), previous = members[id]
            members[id] = current
            if !current.isEmpty, previous != current {
                return MacNotificationEvent(kind: "approval_wait", sourceID: member.id,
                                            target: .team(projectId: member.projectId, memberId: member.id))
            }
        }
        if let todo = event.todo, todos.insert(key(todo.projectId, todo.id)).inserted, !todo.done {
            return MacNotificationEvent(kind: "todo_created", sourceID: todo.id,
                                        target: .projectHome(projectId: todo.projectId))
        }
        if let message = event.message {
            let id = key(message.projectId, message.id)
            guard !reports.contains(id) else { return nil }
            rememberReport(id)
            guard !message.mine, ["완료", "막힘"].contains(message.kind) else { return nil }
            return MacNotificationEvent(kind: message.kind == "완료" ? "report_complete" : "report_blocked",
                                        sourceID: message.id,
                                        target: .chat(projectId: message.projectId, memberId: message.memberId, messageId: message.id))
        }
        return nil
    }

    private func key(_ project: String, _ id: String) -> String { project + ":" + id }
    private func approvalState(_ member: Member) -> String {
        guard member.status == "blocked", !MemberStatusInfo.observationUnavailable(member),
              ["permission", "selection"].contains(member.blockedReason ?? "") || member.hasFolderTrustApproval else { return "" }
        return member.blockedReason ?? "folder_trust"
    }
    private mutating func rememberReport(_ id: String) {
        guard reports.insert(id).inserted else { return }
        reportOrder.append(id)
        if reportOrder.count > 2000 { reports.remove(reportOrder.removeFirst()) }
    }
}

enum MacNotificationPolicy {
    static func badge(_ projects: [ProjectSummary]) -> String? {
        let count = projects.reduce(0) { total, project in
            sum(total, max(0, project.needsCount ?? sum(max(0, project.inboxCount), max(0, project.blockedCount))))
        }
        return count == 0 ? nil : String(count)
    }
    private static func sum(_ lhs: Int, _ rhs: Int) -> Int {
        let result = lhs.addingReportingOverflow(rhs)
        return result.overflow ? Int.max : result.partialValue
    }
    static func isVisible(_ target: PushTarget, frontmost: Bool, projectID: String?, destination: Destination,
                          decisionID: String?, memberID: String?, chatTarget: String?) -> Bool {
        guard frontmost else { return false }
        switch target {
        case .home: return destination == .home
        case .projectHome(let project): return project == projectID && destination == .home && memberID == nil
        case .inbox(let project, let decision): return project == projectID && destination == .inbox && decisionID == decision && memberID == nil
        case .team(let project, let member): return project == projectID && memberID == member
        case .chat(let project, let member, _, _): return project == projectID && destination == .chat && chatTarget == member && memberID == nil
        case .unknown: return false
        }
    }

    /// URL links deliberately have no server event ID: these events were observed by this app.
    static func link(serverID: String, target: PushTarget) -> NotificationLink? {
        let project: String, section: String, id: String
        switch target {
        case .inbox(let p, let d): (project, section, id) = (p, "decisions", d)
        case .team(let p, let m): (project, section, id) = (p, "members", m)
        case .chat(let p, _, let m, _): (project, section, id) = (p, "chat", m)
        default: return nil
        }
        guard let url = URL(string: "iamceo://open/\(serverID)/projects/\(APIClient.segment(project))/\(section)/\(APIClient.segment(id))") else { return nil }
        return NotificationLink(url: url)
    }
}

#if os(macOS)
import AppKit
import UserNotifications

@MainActor protocol MacNotificationDelivering {
    func requestPermission() async throws -> Bool
    func deliver(identifier: String, title: String, metadata: Data) async throws
    func clear()
}

@MainActor private final class SystemMacNotifications: MacNotificationDelivering {
    func requestPermission() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }
    func deliver(identifier: String, title: String, metadata: Data) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = "IAMCEO에서 확인해 주세요."
        content.sound = .default
        // Fixed copy only: no report text, project names, paths, credentials or terminal contents.
        content.userInfo = ["iamceoMac": metadata]
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
    func clear() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
}

private struct MacNotificationEnvelope: Codable, Sendable {
    let serverID: String
    let target: PushTarget
}

/// Attach once at app startup with `MacNotificationService.shared.start(store: store, router: sharedRouter)`.
/// No connection, permission request, preference write or notification occurs merely by initializing this service.
@MainActor @Observable
final class MacNotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = MacNotificationService()
    private(set) var enabled: Bool
    private(set) var permissionNotice: String?
    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private let delivery: any MacNotificationDelivering
    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored private var listener: Task<Void, Never>?
    @ObservationIgnored private var realtime: RealtimeClient?
    @ObservationIgnored private weak var store: AppStore?
    @ObservationIgnored private weak var router: Router?
    @ObservationIgnored private var tracker = MacNotificationTracker()
    @ObservationIgnored private var hostKey: String?
    @ObservationIgnored private var storeBadgeSignature = ""
    @ObservationIgnored private var hostGeneration = UUID()
    @ObservationIgnored private var preferenceGeneration = UUID()
    @ObservationIgnored private var pendingHome: MacNotificationEnvelope?
    @ObservationIgnored private var openingHome = false
    @ObservationIgnored private var foreignHomeNoticeShown = false
    private static let enabledKey = "iamceo.macNotifications.enabled.v1"

    init(defaults: UserDefaults? = .standard, delivery: (any MacNotificationDelivering)? = nil) {
        self.defaults = defaults; self.delivery = delivery ?? SystemMacNotifications()
        enabled = defaults?.bool(forKey: Self.enabledKey) ?? false
        super.init()
    }

    @discardableResult
    func setEnabled(_ value: Bool, api: APIClient? = nil) async -> Bool {
        let id = UUID(); preferenceGeneration = id
        permissionNotice = nil
        do {
            let allowed = value ? try await delivery.requestPermission() : true
            guard preferenceGeneration == id else { return false }
            // T2's narrow API leaves every other server setting and its review revision intact.
            if let api { try await api.setMacScriptNotifications(false) }
            guard preferenceGeneration == id else { return false }
            enabled = value; defaults?.set(value, forKey: Self.enabledKey)
            if !value { delivery.clear() }
            else if monitor != nil { hostKey = nil }
            if !allowed {
                permissionNotice = "Mac의 시스템 설정 → 알림에서 IAMCEO 알림을 허용해 주세요."
            }
            return true
        } catch {
            if preferenceGeneration == id { permissionNotice = friendlyLoadError(error, what: "Mac 알림 설정", verb: "저장하지") }
            return false
        }
    }

    func start(store: AppStore, router: Router) {
        guard monitor == nil, !store.isDemo else { return }
        self.store = store; self.router = router
        UNUserNotificationCenter.current().delegate = self
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.reconcile(store: store)
                do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            }
        }
    }

    func stop() {
        monitor?.cancel(); listener?.cancel(); monitor = nil; listener = nil
        let old = realtime; realtime = nil
        Task { await old?.disconnect() }
        hostKey = nil; hostGeneration = UUID(); tracker = MacNotificationTracker()
        storeBadgeSignature = ""; pendingHome = nil
        NSApp.dockTile.badgeLabel = nil
    }

    private func reconcile(store: AppStore) {
        processPendingHome(store: store)
        let badgeSignature = store.projects.map { "\($0.id):\($0.needsCount ?? -1):\($0.inboxCount):\($0.blockedCount)" }.joined(separator: ",")
        if badgeSignature != storeBadgeSignature {
            storeBadgeSignature = badgeSignature
            NSApp.dockTile.badgeLabel = MacNotificationPolicy.badge(store.projects)
        }
        let key = store.api.flatMap { api in store.serverID.map { store.writeNamespace + ":" + $0 + ":\(ObjectIdentifier(api))" } }
        guard key != hostKey else { return }
        listener?.cancel()
        let old = realtime
        Task { await old?.disconnect() }
        realtime = nil; hostKey = key; hostGeneration = UUID(); tracker = MacNotificationTracker()
        guard key != nil, let api = store.api, let serverID = store.serverID else { return }
        let id = hostGeneration, client = RealtimeClient()
        realtime = client
        listener = Task { [weak self] in
            if self?.enabled == true, store.bootstrap?.settings.macScriptNotifications != false {
                do { try await api.setMacScriptNotifications(false) }
                catch {
                    if let self, self.hostGeneration == id {
                        self.permissionNotice = friendlyLoadError(error, what: "이전 서버 알림 설정", verb: "바꾸지")
                    }
                    return // An uncertain settings PATCH is never replayed by the reconnect loop.
                }
            }
            var seeded = false
            while !Task.isCancelled {
                do {
                    let stream = try await client.connect(api: api)
                    if !seeded {
                        for project in store.projects {
                            let snapshot: ProjectState = try await api.request("/api/projects/\(APIClient.segment(project.id))/state")
                            guard let self, self.hostGeneration == id, !Task.isCancelled else { return }
                            self.tracker.seed(snapshot)
                        }
                        seeded = true
                    }
                    for try await event in stream {
                        guard let self, self.hostGeneration == id, !Task.isCancelled else { return }
                        if let projects = event.projects { NSApp.dockTile.badgeLabel = MacNotificationPolicy.badge(projects) }
                        if let notice = self.tracker.event(event) { await self.post(notice, serverID: serverID, generation: id) }
                    }
                } catch { if Task.isCancelled { return } }
                await client.disconnect()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    private func post(_ event: MacNotificationEvent, serverID: String, generation: UUID) async {
        guard hostGeneration == generation, store?.serverID == serverID else { return }
        await notify(event, serverID: serverID, visible: isTargetVisible(event.target))
    }

    private func isTargetVisible(_ target: PushTarget) -> Bool {
        guard let store, let router else { return false }
        let frontmost = NSApp.isActive && NSApp.keyWindow?.identifier?.rawValue == "IAMCEO.MainWindow"
            && NSApp.keyWindow?.attachedSheet == nil && !router.showSettings
        let chatTarget: String? = router.chatTarget ?? store.members.first(where: { ["conductor", "root"].contains($0.kind) })?.id
        return MacNotificationPolicy.isVisible(target, frontmost: frontmost, projectID: store.selectedProjectID,
                                                destination: router.destination, decisionID: router.decisionID,
                                                memberID: router.memberID ?? router.terminalMemberID, chatTarget: chatTarget)
    }

    func notify(_ event: MacNotificationEvent, serverID: String, visible: Bool) async {
        guard enabled, !visible,
              let metadata = try? JSONEncoder().encode(MacNotificationEnvelope(serverID: serverID, target: event.target)) else { return }
        do {
            try await delivery.deliver(identifier: "\(serverID):\(event.kind):\(event.sourceID)", title: event.title, metadata: metadata)
        } catch { permissionNotice = friendlyLoadError(error, what: "Mac 알림", verb: "띄우지") }
    }

    private func receiveTap(_ envelope: MacNotificationEnvelope) {
        NSApp.activate(ignoringOtherApps: true)
        if let router { router.showInMainWindow(router.destination) }
        if let link = MacNotificationPolicy.link(serverID: envelope.serverID, target: envelope.target) {
            // The existing app mailbox retains cold-start taps until connection validation finishes.
            NotificationInbox.shared.receive(link, tapped: true)
            if let store, let router { Task { await store.processNotifications(router: router) } }
        } else if case .projectHome = envelope.target, UUID(uuidString: envelope.serverID) != nil {
            pendingHome = envelope; foreignHomeNoticeShown = false
            if let store { processPendingHome(store: store) }
        }
    }

    private func processPendingHome(store: AppStore) {
        guard let envelope = pendingHome, !openingHome, let router, let serverID = store.serverID,
              store.connectionStatus == .connected, !store.isRevalidating else { return }
        guard serverID.lowercased() == envelope.serverID.lowercased() else {
            if !foreignHomeNoticeShown { router.navigationNotice = "이 알림의 Mac에 연결해 주세요."; foreignHomeNoticeShown = true }
            return
        }
        pendingHome = nil; openingHome = true
        Task {
            defer { openingHome = false }
            guard case .projectHome(let project) = envelope.target, let api = store.api else { return }
            let generation = store.writeNamespace, revision = router.navigationRevision, reset = router.projectResetRevision
            do {
                let context = try await api.notificationContext(target: envelope.target)
                guard store.writeNamespace == generation, store.api === api, store.serverID?.lowercased() == envelope.serverID.lowercased(),
                      router.navigationRevision == revision else { return }
                guard context.state?.project.id == project, context.state?.project.archived == false else {
                    router.navigationNotice = "알림의 프로젝트가 없거나 보관되었습니다."; return
                }
                let changed = store.selectedProjectID != project
                await store.selectProject(id: project)
                guard store.writeNamespace == generation, store.serverID?.lowercased() == envelope.serverID.lowercased(), store.selectedProjectID == project,
                      router.navigationRevision == revision else { return }
                router.applyNotification(NotificationRoute(target: envelope.target), afterProjectChange: changed, resetRevision: reset)
            } catch {
                if store.writeNamespace == generation, router.navigationRevision == revision {
                    router.navigationNotice = friendlyLoadError(error, what: "알림의 프로젝트", verb: "열지")
                }
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let data = notification.request.content.userInfo["iamceoMac"] as? Data,
              let envelope = try? JSONDecoder().decode(MacNotificationEnvelope.self, from: data) else { return [] }
        return await MainActor.run {
            guard self.enabled, self.store?.serverID == envelope.serverID else { return [] }
            return self.isTargetVisible(envelope.target) ? [] : [.banner, .sound]
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let envelope = (response.notification.request.content.userInfo["iamceoMac"] as? Data)
            .flatMap { try? JSONDecoder().decode(MacNotificationEnvelope.self, from: $0) }
        completionHandler()
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier, let envelope {
            Task { @MainActor in self.receiveTap(envelope) }
        }
    }
}
#endif
