import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Launch arguments: `--demo` (read-only sample workspace), `--screen <destination>` and, in demo only, `--open <id>`.
enum LaunchOptions {
    static let arguments = ProcessInfo.processInfo.arguments
    static let demo = arguments.contains("--demo")
    /// Review hook (DEBUG): the sample workspace lets the iPhone composer take the keyboard, so screenshots can show it.
    #if DEBUG
    static let reviewTyping = arguments.contains("--typing")
    #else
    static let reviewTyping = false
    #endif

    static func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    @MainActor static func makeRouter() -> Router {
        let initial = value(after: "--screen").flatMap(Destination.init(rawValue:)) ?? .home
        let router = Router(destination: initial)
        // Screenshot/review hooks for the read-only sample workspace only.
        if demo, let value = value(after: "--open") {
            switch initial {
            case .inbox: router.decisionID = value
            case .team: router.memberID = value
            case .files: router.fileID = value
            case .chat: router.chatTarget = value
            case .home: break
            }
        }
        return router
    }
}

@main
struct IAMCEOApp: App {
    /// App-level scene phase includes the settings window and every main window.
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
    #endif
    @State private var store: AppStore
    @State private var drafts: DraftStore
    @State private var lifecycle = ApplicationLifecycle()
    init() {
        let store = AppStore(demo: LaunchOptions.demo, persistCredentials: !LaunchOptions.demo)
        _store = State(initialValue: store)
        _drafts = State(initialValue: store.drafts)
    }
    var body: some Scene {
        // A fixed id keeps the scene identity stable across builds (the default id is derived from the root view type).
        WindowGroup(id: "main") {
            MainWindow(store: store, drafts: drafts)
                .modifier(ApplicationLifecycleHooks(lifecycle: lifecycle, store: store))
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            lifecycle.active = phase == .active
            lifecycle.apply(to: store)
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 920)
        .windowToolbarStyle(.unified)
        .commands { CommandGroup(replacing: .newItem) {} }
        #endif
        #if os(macOS)
        SwiftUI.Settings {
            SettingsWindow(store: store, drafts: drafts)
                .modifier(ApplicationLifecycleHooks(lifecycle: lifecycle, store: store))
        }
        #endif
    }
}

@MainActor @Observable
private final class ApplicationLifecycle {
    var active = false
    var sleeping = false
    var protectedDataAvailable = true
    func apply(to store: AppStore) { store.setForeground(active && !sleeping && protectedDataAvailable) }
}

private struct ApplicationLifecycleHooks: ViewModifier {
    let lifecycle: ApplicationLifecycle
    let store: AppStore
    func body(content: Content) -> some View {
        content
            #if os(macOS)
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in
                lifecycle.sleeping = true; lifecycle.apply(to: store)
            }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
                lifecycle.sleeping = false; lifecycle.apply(to: store)
            }
            #else
            .onAppear {
                lifecycle.protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable
                lifecycle.apply(to: store)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataWillBecomeUnavailableNotification)) { _ in
                lifecycle.protectedDataAvailable = false; lifecycle.apply(to: store)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                lifecycle.protectedDataAvailable = true; lifecycle.apply(to: store)
            }
            #endif
    }
}

/// One window. The store and drafts are shared; navigation (tab, selection, open sheets) belongs to the window, so a
/// second iPad window neither mirrors nor resets the first.
private struct MainWindow: View {
    let store: AppStore
    let drafts: DraftStore
    @State private var router = LaunchOptions.makeRouter()
    var body: some View {
        AppShell()
            .environment(store)
            .environment(router)
            .environment(drafts)
            .preferredColorScheme(.dark)
            .tint(CE.accent)
            #if os(macOS)
            // Sidebar ≤320 + detail ≥560 fit inside this minimum (see AppShell.desk).
            .frame(minWidth: 1040, minHeight: 680)
            #endif
    }
}

#if os(macOS)
private struct SettingsWindow: View {
    let store: AppStore
    let drafts: DraftStore
    @State private var router = Router()
    var body: some View {
        SettingsView()
            .environment(store)
            .environment(router)
            .environment(drafts)
            .preferredColorScheme(.dark)
            .tint(CE.accent)
    }
}
#endif
