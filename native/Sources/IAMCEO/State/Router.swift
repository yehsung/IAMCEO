import SwiftUI
import Observation

enum Destination: String, CaseIterable, Identifiable {
    case home, inbox, team, chat, files
    var id: String { rawValue }
    var title: String { switch self { case .home: "홈"; case .inbox: "결재함"; case .team: "팀"; case .chat: "대화"; case .files: "자료" } }
    var icon: String { switch self { case .home: "square.grid.2x2"; case .inbox: "tray"; case .team: "person.2"; case .chat: "bubble.left.and.bubble.right"; case .files: "folder" } }
}

enum PhoneRoute: Hashable {
    case member(String), file(String)
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
/// Mac shows the member detail as a sheet over any screen; iPhone pushes it on the current tab.
@MainActor @Observable
final class Router {
    var destination: Destination {
        didSet {
            visitedDestinations.insert(destination)
            if destination != oldValue { cancelPendingNavigation() }
            if !restoringDestination { destinationChanged?(destination) }
        }
    }
    private(set) var visitedDestinations: Set<Destination>
    var phonePaths: [Destination: [PhoneRoute]] = [:]
    var usesPhoneNavigation = !isMac
    @ObservationIgnored var destinationChanged: ((Destination) -> Void)?
    @ObservationIgnored private var restoringDestination = false
    /// A settings-window link requests activation even when its destination was already selected.
    private(set) var mainWindowRequest = 0
    private(set) var isOpeningNotification = false
    @ObservationIgnored private var notificationOpeningID: UUID?
    var inboxReview = InboxReviewState()
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
    /// iPhone: a field inside the content (a decision card's answer or memo) has the keyboard. The docked composer
    /// steps aside meanwhile, so one field rides the keyboard and an answer cannot land in the wrong box.
    var inlineFieldFocused = false

    init(destination: Destination = .home, usesPhoneNavigation: Bool = !isMac) {
        self.destination = destination; visitedDestinations = [destination]
        self.usesPhoneNavigation = usesPhoneNavigation
    }
    func restoreDestination(_ destination: Destination) {
        restoringDestination = true; self.destination = destination; restoringDestination = false
    }
    func showInMainWindow(_ destination: Destination) {
        go(destination); showSettings = false; mainWindowRequest &+= 1
    }
    func path(for tab: Destination) -> Binding<[PhoneRoute]> {
        Binding(get: { self.phonePaths[tab] ?? [] }, set: { self.phonePaths[tab] = $0 })
    }

    func go(_ destination: Destination) { cancelPendingNavigation(); self.destination = destination }
    func openDecision(_ id: String) { cancelPendingNavigation(); phonePaths[.inbox] = []; decisionID = id; destination = .inbox }
    /// Mac: the shell's member sheet opens over the current screen. iPhone/iPad: 팀 pushes the detail.
    func openMember(_ id: String) {
        cancelPendingNavigation()
        if usesPhoneNavigation { phonePaths[destination, default: []].append(.member(id)) }
        else { memberID = id; if !isMac { destination = .team } }
    }
    func openFile(_ id: String) {
        cancelPendingNavigation()
        if usesPhoneNavigation { phonePaths[destination, default: []].append(.file(id)) }
        else { fileID = id; destination = .files }
    }
    func openChat(_ target: String?) { cancelPendingNavigation(); phonePaths[.chat] = []; chatTarget = target; chatMessageID = nil; destination = .chat }
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

    func cancelPendingNavigation() {
        navigationRevision &+= 1; pendingRoute = nil
        notificationOpeningID = nil; isOpeningNotification = false
    }
    @discardableResult func beginOpeningNotification(_ target: PushTarget) -> UUID {
        cancelPendingNavigation()
        switch target {
        case .home, .projectHome: destination = .home
        case .inbox: destination = .inbox
        case .team: destination = .team
        case .chat: destination = .chat
        case .unknown: break
        }
        phonePaths[destination] = []
        if case .team = target { memberID = nil }
        let id = UUID(); notificationOpeningID = id; isOpeningNotification = true
        return id
    }
    func finishOpeningNotification(_ id: UUID) {
        guard notificationOpeningID == id else { return }
        notificationOpeningID = nil; isOpeningNotification = false
    }

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
        case .home, .projectHome: destination = .home
        case .inbox(_, let id): openDecision(id)
        case .team(_, let id):
            destination = .team
            if usesPhoneNavigation { phonePaths[.team] = [.member(id)] }
            else { openMember(id) }
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
        inboxReview = InboxReviewState()
        inlineFieldFocused = false
        decisionID = nil; memberID = nil; fileID = nil; chatTarget = nil; terminalMemberID = nil
        phonePaths = [:]
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

/// Review snapshots and pending answers survive file navigation, but never cross project/connection resets.
@MainActor @Observable
final class InboxReviewState {
    var segment: InboxSegment = .open
    // Review state for this visit. Memos live in DraftStore and survive the visit.
    var reviews: [String: DecisionReview] = [:]
    /// Explicit memo-only review on option cards. Free answers use one final confirmation directly.
    var memoOnly: Set<String> = []
    var engaged: Set<String> = []
    var inFlight: Set<String> = []
    var answeredHere: Set<String> = []
    var cardErrors: [String: String] = [:]
    var contextID = UUID()
    var visitID = UUID()
    var memoRevisions: [String: Int] = [:]
    var expandedDetail: Set<String> = []
    var batchArmed: [String: [String]] = [:]
    var batchBusy: Set<String> = []
    var batchErrors: [String: String] = [:]
    var expandedDone: Set<String> = []
    var scrollID: String?
    var scrollLocations: [String: InboxScrollLocation] = [:]

    @discardableResult func beginSubmission(_ id: String) -> Bool {
        guard !inFlight.contains(id) else { return false }
        inFlight.insert(id)
        return true
    }
}
