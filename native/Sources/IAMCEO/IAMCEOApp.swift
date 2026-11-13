import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Launch arguments: `--demo` (sample workspace on the in-app sample server), `--screen <destination>` and, in demo only, `--open <id>`.
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

/// The entry point. W(0.2.5): the app's display language is settled before anything reads a localized string
/// (`AppLanguageLaunch`: the owner's choice in Settings, the system per-app language, or — on a first launch — the App
/// Store country on iPhone and the device language on Mac). The bundle picks its string table once per launch.
@main
enum IAMCEOLauncher {
    @MainActor static func main() {
        AppLanguageLaunch.prepare()
        IAMCEOApp.main()
    }
}

struct IAMCEOApp: App {
    /// App-level scene phase includes the settings window and every main window.
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
    #endif
    @State private var session: AppSession
    private var store: AppStore { session.store }
    private var drafts: DraftStore { session.store.drafts }
    @State private var lifecycle = ApplicationLifecycle()
    #if os(macOS)
    private var sharedRouter: Router { session.router }
    #endif
    init() {
        #if os(macOS)
        UserDefaults.standard.register(defaults: ["NSApplicationCrashOnExceptions": true])
        #endif
        #if DEBUG
        // 화면 견본(F1): `--last-seen-preview` 는 마지막으로 본 상태와 연결되면 보낼 글을 띄운다. 연결·파일을 쓰지 않는다.
        let store = LaunchOptions.arguments.contains("--last-seen-preview") ? AppStore.lastSeenPreview()
            : AppStore(demo: LaunchOptions.demo, persistCredentials: !LaunchOptions.demo)
        #else
        let store = AppStore(demo: LaunchOptions.demo, persistCredentials: !LaunchOptions.demo)
        #endif
        _session = State(initialValue: AppSession(store: store, router: LaunchOptions.makeRouter()))
        // 지난 실행이 임시 폴더에 남긴 첨부 캐시를 치운다. 화면 준비를 기다리게 하지 않는다.
        Task.detached(priority: .utility) { TemporaryFiles.sweepStale() }
    }
    var body: some Scene {
        // A fixed id keeps the scene identity stable across builds (the default id is derived from the root view type).
        WindowGroup(id: "main") {
            #if os(macOS)
            MainWindow(store: store, drafts: drafts, sharedRouter: sharedRouter)
                .modifier(ApplicationLifecycleHooks(lifecycle: lifecycle, store: store))
                // The app's own notifications and Dock badge (A-82, A-101): started once with the first window, kept
                // for the app's life (it only posts when the owner turned Mac notifications on in 설정).
                .task { MacNotificationService.shared.start(store: store, router: sharedRouter) }
                // D6 새 버전 확인(하루 한 번)과 D1 '옛 버전 서버를 새 버전으로 다시 시작' 질문(앱 빌드마다 한 번).
                .modifier(VersionWatchHooks(store: store))
            #else
            MainWindow(store: store, drafts: drafts, sharedRouter: session.router)
                .environment(\.appSession, session)
                .id(ObjectIdentifier(store))
                .modifier(ApplicationLifecycleHooks(lifecycle: lifecycle, store: store))
            #endif
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            lifecycle.active = ApplicationLifecycle.syncs(in: phase)
            lifecycle.apply(to: store)
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 920)
        .windowToolbarStyle(.unified)
        .commands { MacCommands(store: store, router: sharedRouter) }
        #endif
        #if os(macOS)
        WindowGroup(id: "terminal", for: String.self) { $memberID in
            TerminalWindowContent(memberID: memberID).environment(store).environment(sharedRouter).environment(drafts)
        }
        .defaultSize(width: 1040, height: 700)
        SwiftUI.Settings {
            SettingsWindow(store: store, drafts: drafts, router: sharedRouter)
                .modifier(ApplicationLifecycleHooks(lifecycle: lifecycle, store: store))
        }
        #endif
    }
}

/// Replacing the workspace also discards its navigation, sheets and in-memory drafts.
/// No mode preference is persisted; normal launches still use the real connection flow.
@MainActor @Observable
final class AppSession {
    private(set) var store: AppStore
    private(set) var router: Router
    @ObservationIgnored private let makeConnectionStore: () -> AppStore

    init(store: AppStore, router: Router = Router(),
         makeConnectionStore: @escaping () -> AppStore = { AppStore(restoreCredentials: false) }) {
        self.store = store
        self.router = router
        self.makeConnectionStore = makeConnectionStore
    }

    func browseSample() {
        guard !store.isDemo else { return }
        replaceStore(AppStore(demo: true, persistCredentials: false))
    }

    func connectToMac() {
        guard store.isDemo else { return }
        replaceStore(makeConnectionStore())
    }

    private func replaceStore(_ next: AppStore) {
        store.prepareForReplacement()
        router.cancelPendingNavigation()
        router = Router()
        store = next
    }
}

private struct AppSessionKey: EnvironmentKey {
    static let defaultValue: AppSession? = nil
}

extension EnvironmentValues {
    var appSession: AppSession? {
        get { self[AppSessionKey.self] }
        set { self[AppSessionKey.self] = newValue }
    }
}

@MainActor @Observable
final class ApplicationLifecycle {
    var active = false
    var sleeping = false
    var protectedDataAvailable = true
    /// Mac은 다른 앱을 쓰는 동안에도 창이 옆에 떠 있다. 맨 앞 앱이 아니라고(.inactive) 동기화를 멈추면
    /// 화면이 얼고 돌아올 때마다 전체를 다시 읽는다. 창이 모두 사라졌을 때(.background)와 잠자기에서만 쉰다.
    nonisolated static func syncs(in phase: ScenePhase) -> Bool {
        #if os(macOS)
        phase != .background
        #else
        phase == .active
        #endif
    }
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
/// second window neither mirrors nor resets the first. (Only Mac opens more than one: the iOS app is iPhone-only.)
private struct MainWindow: View {
    let store: AppStore
    let drafts: DraftStore
    var sharedRouter: Router? = nil
    @State private var windowRouter = LaunchOptions.makeRouter()
    private var router: Router { sharedRouter ?? windowRouter }
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
            .background { AppWindowReader { $0?.identifier = NSUserInterfaceItemIdentifier("IAMCEO.MainWindow") } }
            #endif
    }
}

#if os(macOS)
/// The menu bar (Mac): 파일 holds 새 프로젝트 and 팀장 추가, 이동 holds the five screens, the project before and after
/// this one in the rail's order, the composer and 지금 동기화. These are the app's only keyboard shortcuts for them,
/// so a key and its menu item can never drift apart. Each acts on the main window, bringing it to the front when
/// the settings window has the focus.
private struct MacCommands: Commands {
    let store: AppStore
    let router: Router

    /// The rail's order: 본사 first, then the projects.
    private var projects: [ProjectSummary] { store.projects.filter(\.isHq) + store.projects.filter { !$0.isHq } }

    private func neighbour(_ step: Int) -> ProjectSummary? {
        let list = projects
        guard list.count > 1,
              let index = list.firstIndex(where: { $0.id == store.selectedProjectID }) else { return nil }
        let next = index + step
        return list.indices.contains(next) ? list[next] : nil
    }

    private func switchTo(_ project: ProjectSummary?) {
        guard let project else { return }
        router.showInMainWindow(router.destination)
        Task { await store.selectProject(id: project.id) }
    }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("새 프로젝트…") { router.showInMainWindow(router.destination); router.showNewProject = true }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(store.isDemo || !store.canWrite)
            Button("팀장 추가…") { router.showInMainWindow(router.destination); router.showNewMember = true }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(store.isDemo || !store.uiCanWrite || store.isArchive || store.selectedProjectID == nil)
        }
        CommandMenu("이동") {
            ForEach(Array(Destination.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { router.showInMainWindow(tab) }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                    .disabled(store.bootstrap == nil)
            }
            Divider()
            Button("이전 프로젝트") { switchTo(neighbour(-1)) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .control])
                .disabled(neighbour(-1) == nil)
            Button("다음 프로젝트") { switchTo(neighbour(1)) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .control])
                .disabled(neighbour(1) == nil)
            Divider()
            Button("입력칸으로") { router.showInMainWindow(router.destination); router.focusComposer &+= 1 }
                .keyboardShortcut("l", modifiers: .command)
                .disabled(store.isArchive || store.bootstrap == nil)
            Button("지금 동기화") { Task { await store.refresh() } }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(store.bootstrap == nil)
        }
    }
}

private struct SettingsWindow: View {
    let store: AppStore
    let drafts: DraftStore
    let router: Router
    @Environment(\.openWindow) private var openWindow
    @State private var settingsWindow: NSWindow?
    var body: some View {
        SettingsView()
            .environment(store)
            .environment(router)
            .environment(drafts)
            .preferredColorScheme(.dark)
            .tint(CE.accent)
            .background { AppWindowReader { settingsWindow = $0 } }
            .onChange(of: router.mainWindowRequest) { _, _ in
                if let main = NSApp.windows.first(where: { $0.identifier?.rawValue == "IAMCEO.MainWindow" }) {
                    if main.isMiniaturized { main.deminiaturize(nil) }
                    main.makeKeyAndOrderFront(nil)
                } else { openWindow(id: "main") }
                settingsWindow?.close()
                NSApp.activate(ignoringOtherApps: true)
            }
    }
}

private struct AppWindowReader: NSViewRepresentable {
    let capture: (NSWindow?) -> Void
    func makeNSView(context: Context) -> WindowView { WindowView(capture: capture) }
    func updateNSView(_ nsView: WindowView, context: Context) {}
    final class WindowView: NSView {
        let capture: (NSWindow?) -> Void
        init(capture: @escaping (NSWindow?) -> Void) { self.capture = capture; super.init(frame: .zero) }
        required init?(coder: NSCoder) { return nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let window = window
            DispatchQueue.main.async { self.capture(window) }
        }
    }
}
#endif
