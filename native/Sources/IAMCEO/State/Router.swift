import SwiftUI
import Observation

enum Destination: String, CaseIterable, Identifiable {
    case home, inbox, team, chat, files
    var id: String { rawValue }
    var title: String { switch self { case .home: "홈"; case .inbox: "결재함"; case .team: "팀"; case .chat: "대화"; case .files: "자료" } }
    var icon: String { switch self { case .home: "square.grid.2x2"; case .inbox: "tray"; case .team: "person.2"; case .chat: "bubble.left.and.bubble.right"; case .files: "folder" } }
}

enum ProjectManagementMode: String { case rename, archive, restore, settings }
struct ProjectManagementSelection: Identifiable {
    let projectID: String
    let mode: ProjectManagementMode
    var id: String { "\(projectID):\(mode.rawValue)" }
}

struct NotificationRoute {
    let target: PushTarget
    var chatTarget: String? = nil
    var chatMessageID: String? = nil
    var notice: String? = nil
}

/// Cross-screen navigation shared by every view: which screen is shown and which item is open in it.
/// Mac shows the member detail as a sheet over any screen; iPhone/iPad push it on 팀.
@MainActor @Observable
final class Router {
    var destination: Destination { didSet { if destination != oldValue { cancelPendingNavigation() } } }
    var decisionID: String?
    var memberID: String?
    var fileID: String?
    /// Composer / chat recipient. nil = 총괄 (project conversation).
    var chatTarget: String?
    var chatMessageID: String?
    var navigationNotice: String?
    var projectManagement: ProjectManagementSelection?
    private(set) var navigationRevision = 0
    private(set) var projectResetRevision = 0
    @ObservationIgnored private var pendingRoute: NotificationRoute?
    /// Member whose terminal sheet is open.
    var terminalMemberID: String?
    var showSettings = false
    var showNewProject = false
    var showNewMember = false
    /// Mac: the QR sheet for connecting an iPhone.
    var showPairing = false
    /// Bumped to move keyboard focus into the docked composer (Mac).
    var focusComposer = 0

    init(destination: Destination = .home) { self.destination = destination }

    func go(_ destination: Destination) { cancelPendingNavigation(); self.destination = destination }
    func openDecision(_ id: String) { cancelPendingNavigation(); decisionID = id; destination = .inbox }
    /// Mac: the shell's member sheet opens over the current screen. iPhone/iPad: 팀 pushes the detail.
    func openMember(_ id: String) { cancelPendingNavigation(); memberID = id; if !isMac { destination = .team } }
    func openFile(_ id: String) { cancelPendingNavigation(); fileID = id; destination = .files }
    func openChat(_ target: String?) { cancelPendingNavigation(); chatTarget = target; chatMessageID = nil; destination = .chat }
    func openTerminal(_ memberID: String) { cancelPendingNavigation(); terminalMemberID = memberID }
    func openTerminal(_ member: Member, store: AppStore) {
        Task {
            let current = store.members.first { $0.id == member.id } ?? member
            guard store.canOpenTerminal(current) else { return }
            guard TerminalAvailability.needsWake(current) else { openTerminal(current.id); return }
            cancelPendingNavigation()
            let revision = navigationRevision, projectRevision = projectResetRevision
            if await store.wakeTerminal(current), navigationRevision == revision, projectResetRevision == projectRevision {
                openTerminal(current.id)
            }
        }
    }
    func manageProject(id: String, mode: ProjectManagementMode) {
        projectManagement = ProjectManagementSelection(projectID: id, mode: mode)
    }

    func cancelPendingNavigation() { navigationRevision &+= 1; pendingRoute = nil }

    /// Selection may finish before SwiftUI delivers onChange. That reset owns the final application.
    func applyNotification(_ route: NotificationRoute, afterProjectChange: Bool, resetRevision: Int) {
        if afterProjectChange, projectResetRevision == resetRevision { pendingRoute = route }
        else { apply(route) }
    }

    private func apply(_ route: NotificationRoute) {
        pendingRoute = nil
        decisionID = nil; memberID = nil; fileID = nil; chatTarget = nil; terminalMemberID = nil; chatMessageID = nil
        showNewMember = false; showSettings = false; showPairing = false; projectManagement = nil
        switch route.target {
        case .home: destination = .home
        case .inbox(_, let id): openDecision(id)
        case .team(_, let id): openMember(id)
        case .chat:
            openChat(route.chatTarget); chatMessageID = route.chatMessageID
        case .unknown: return
        }
        navigationNotice = route.notice
    }

    func resetForConnectionChange() {
        cancelPendingNavigation(); resetForProjectChange()
        projectManagement = nil; showSettings = false; showPairing = false; showNewProject = false
    }
    /// Selections belong to one project; never carry them into another.
    func resetForProjectChange() {
        decisionID = nil; memberID = nil; fileID = nil; chatTarget = nil; terminalMemberID = nil
        chatMessageID = nil; showNewMember = false; navigationNotice = nil
        projectResetRevision &+= 1
        if let route = pendingRoute { apply(route) }
    }
}

private struct WideLayoutKey: EnvironmentKey { static let defaultValue = isMac }
extension EnvironmentValues {
    /// True on Mac and regular-width iPad: use master–detail instead of push navigation.
    var ceWide: Bool {
        get { self[WideLayoutKey.self] }
        set { self[WideLayoutKey.self] = newValue }
    }
}
