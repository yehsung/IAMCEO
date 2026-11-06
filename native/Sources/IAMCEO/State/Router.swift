import SwiftUI
import Observation

enum Destination: String, CaseIterable, Identifiable {
    case home, inbox, team, chat, files
    var id: String { rawValue }
    var title: String { switch self { case .home: "홈"; case .inbox: "결재함"; case .team: "팀"; case .chat: "대화"; case .files: "자료" } }
    var icon: String { switch self { case .home: "square.grid.2x2"; case .inbox: "tray"; case .team: "person.2"; case .chat: "bubble.left.and.bubble.right"; case .files: "folder" } }
}

/// Cross-screen navigation shared by every view: which screen is shown and which item is open in it.
/// Mac shows the member detail as a sheet over any screen; iPhone/iPad push it on 팀.
@MainActor @Observable
final class Router {
    var destination: Destination
    var decisionID: String?
    var memberID: String?
    var fileID: String?
    /// Composer / chat recipient. nil = 총괄 (project conversation).
    var chatTarget: String?
    /// Member whose terminal sheet is open.
    var terminalMemberID: String?
    var showSettings = false
    var showNewProject = false
    var showNewMember = false
    var showCompose = false
    /// Mac: the QR sheet for connecting an iPhone.
    var showPairing = false
    /// Bumped to move keyboard focus into the docked composer (Mac).
    var focusComposer = 0

    init(destination: Destination = .home) { self.destination = destination }

    func go(_ destination: Destination) { self.destination = destination }
    func openDecision(_ id: String) { decisionID = id; destination = .inbox }
    /// Mac: the shell's member sheet opens over the current screen. iPhone/iPad: 팀 pushes the detail.
    func openMember(_ id: String) { memberID = id; if !isMac { destination = .team } }
    func openFile(_ id: String) { fileID = id; destination = .files }
    func openChat(_ target: String?) { chatTarget = target; destination = .chat }
    func openTerminal(_ memberID: String) { terminalMemberID = memberID }
    /// Selections belong to one project; never carry them into another.
    func resetForProjectChange() {
        decisionID = nil; memberID = nil; fileID = nil; chatTarget = nil; terminalMemberID = nil
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
