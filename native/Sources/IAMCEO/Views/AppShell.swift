import SwiftUI
#if os(macOS)
import AppKit
#endif

/// App frame, after the web shell the owner likes: Mac = glass rail (projects) + title + centred glass tabs + docked
/// composer; iPhone = project title menu + tab bar with badges + compose access. On Mac the member detail is a glass
/// drawer inside the window (a sibling of the rail), not a system sheet.
struct AppShell: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var showArchive = false
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    #if DEBUG && os(iOS)
    /// `--sheet keybar`: the terminal key bar over the keyboard (review hook, sample data only).
    @State private var keyBarPreview = false
    #endif
    #if os(macOS)
    @State private var attachmentIntake = MacAttachmentIntake()
    @Environment(\.openSettings) private var openSettings
    /// Window width, for the member drawer's width (40% of the window, 440…560).
    @State private var windowWidth: CGFloat = 1440
    /// The whole window (under the toolbar too), so the detail column can redraw the window's aurora in place.
    @State private var windowSize: CGSize = .zero
    /// The detail column's width, for the headline's share of the toolbar.
    @State private var detailWidth: CGFloat = 1176
    #endif
    private var needsConnection: Bool { store.bootstrap == nil && !store.isDemo }

    var body: some View {
        @Bindable var router = router
        ZStack {
            AmbientBackground()
            #if os(macOS)
            GeometryReader { geo in
                Color.clear.onChange(of: geo.size, initial: true) { _, size in windowSize = size }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            if !needsConnection { StageLights() }
            #endif
            if needsConnection {
                ConnectionView()
            } else {
                #if os(macOS)
                desk
                #else
                phone.environment(\.ceWide, sizeClass == .regular)
                #endif
            }
        }
        .foregroundStyle(CE.ink)
        .projectManagementSheets(enabled: !router.showSettings && !showArchive)
        .sheet(isPresented: $showArchive) { ArchiveLibraryView() }
        #if DEBUG && os(iOS)
        .sheet(isPresented: $keyBarPreview) { TerminalKeyBarPreview() }
        #endif
        .sheet(isPresented: $router.showNewProject) { NewProjectView() }
        .sheet(isPresented: $router.showNewMember) { NewMemberView() }
        .sheet(item: rootTerminal) { TerminalView(member: $0) }
        #if os(macOS)
        // Settings is its own window on Mac.
        .onChange(of: router.showSettings) { _, show in
            guard show else { return }
            router.showSettings = false
            openSettings()
        }
        .sheet(isPresented: $router.showPairing) { MacPairingSheet() }
        // "지시" from the member drawer: close it so the docked composer can take focus.
        .onChange(of: router.focusComposer) { _, _ in router.memberID = nil }
        // The tabs and ⌘1…⌘5 stay usable while the drawer is open: going to another screen closes it. (`--open` sets
        // both values at launch, so this never fires for it; on Mac `openMember` never changes the destination.)
        .onChange(of: router.destination) { _, _ in router.memberID = nil }
        #else
        .sheet(isPresented: $router.showSettings) { SettingsView() }
        .sheet(isPresented: $router.showCompose) { QuickComposeSheet() }
        #endif
        #if DEBUG && os(iOS)
        // Development hook (simulator has no camera and cannot tap the system "open in IAMCEO?" prompt):
        // `--pair <iamceo://pair?…>` runs the same pairing path as a scanned QR.
        .task {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "--pair"), args.indices.contains(i + 1),
                  let url = URL(string: args[i + 1]), let link = PairingLink(url: url) else { return }
            await store.pair(with: link, device: UIDevice.current.name)
        }
        #endif
        // A pairing QR read by the system camera opens iamceo://pair?… — trade it for a connection right away.
        .onOpenURL { url in
            guard !store.isDemo else { return }
            if let notification = NotificationLink(url: url) {
                NotificationInbox.shared.receive(notification, tapped: true)
                return
            }
            guard let link = PairingLink(url: url) else { return }
            #if os(iOS)
            Task { await store.pair(with: link, device: UIDevice.current.name) }
            #else
            store.errorMessage = "이 링크는 iPhone에서 여는 연결 QR입니다."
            _ = link
            #endif
        }
        .onChange(of: "\(scenePhase == .active):\(store.connectionStatus.rawValue):\(store.isRevalidating):\(store.serverID ?? ""):\(NotificationInbox.shared.refreshRevision):\(NotificationInbox.shared.pending.count)", initial: true) { _, _ in
            store.registerRouter(router)
            guard scenePhase == .active else { router.cancelPendingNavigation(); return }
            // Consuming a tap changes the mailbox. It must not cancel its own validation request.
            Task { await store.processNotifications(router: router) }
        }
        // Foreground/background polling is driven by the App's aggregate scene phase (IAMCEOApp).
        .onChange(of: "\(store.selectedProjectID ?? ""):\(store.isArchive)") { _, _ in router.resetForProjectChange() }
        // The store is shared by every window: a window that appears later (second iPad window, Mac window reopened
        // after ⌘W) must not tear down a live or in-progress connection.
        .task {
            guard !store.isDemo, store.bootstrap == nil, store.connectionStatus != .connecting,
                  !store.endpoint.isEmpty, !store.accessCode.isEmpty else { return }
            await store.connect()
        }
        #if DEBUG
        // Review hook for the read-only sample workspace: `--sheet archive|pairing|new-project|new-member|settings|
        // rename|terminal:<memberID>` opens that popup at launch (screenshots of sheets).
        .task {
            guard store.isDemo, let sheet = LaunchOptions.value(after: "--sheet") else { return }
            try? await Task.sleep(for: .milliseconds(400))
            switch sheet {
            case "archive": showArchive = true
            case "pairing": router.showPairing = true
            case "new-project", "folder-picker", "github-clone": router.showNewProject = true
            case "new-member": router.showNewMember = true
            case "settings": router.showSettings = true
            case "rename": if let id = store.selectedProjectID { router.manageProject(id: id, mode: .rename) }
            #if os(iOS)
            case "keybar": keyBarPreview = true
            #endif
            default: if sheet.hasPrefix("terminal:") { router.terminalMemberID = String(sheet.dropFirst("terminal:".count)) }
            }
        }
        #endif
        #if DEBUG && os(macOS)
        // Review hook: `--peek` keeps every window of the sample app on the current Space (also over a full-screen app)
        // with all but its last 2pt column left of the display, so `screencapture -l` can read it without showing it
        // to the person at the Mac.
        .task {
            guard store.isDemo, LaunchOptions.arguments.contains("--peek") else { return }
            for _ in 0..<160 {
                for window in NSApp.windows where window.sheetParent == nil && window.isVisible {
                    window.collectionBehavior.insert([.canJoinAllSpaces, .fullScreenAuxiliary])
                    let target = NSPoint(x: -(window.frame.width - 2), y: 0)
                    if window.frame.origin != target { window.setFrameOrigin(target); window.orderFrontRegardless() }
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        // Review hook: `--snapshot <dir>` draws every window of the sample app into <dir>/window-<n>.png after the
        // screen settles, then quits (AppKit cacheDisplay: layout is right, materials draw grey).
        .task {
            guard store.isDemo, let dir = LaunchOptions.value(after: "--snapshot") else { return }
            let delay = Double(LaunchOptions.value(after: "--snapshot-delay") ?? "") ?? 3
            try? await Task.sleep(for: .seconds(delay))
            var index = 0
            for window in NSApp.windows where window.isVisible && window.frame.width >= 200 {
                guard let view = window.contentView?.superview ?? window.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
                view.cacheDisplay(in: view.bounds, to: rep)
                index += 1
                let kind = window.sheetParent != nil ? "sheet" : (window.identifier?.rawValue.contains("Settings") == true ? "settings" : "window")
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(kind)-\(index).png"))
            }
            exit(0)
        }
        #endif
    }

    /// Terminal sheet from the window root, on both platforms. The Mac member drawer lives inside the window, so the
    /// terminal it opens is presented here too and stays open if the drawer closes.
    private var rootTerminal: Binding<Member?> {
        Binding(get: { terminalMember }, set: { router.terminalMemberID = $0?.id })
    }

    private var terminalMember: Member? {
        guard !store.isArchive else { return nil }
        return router.terminalMemberID.flatMap { id in store.members.first { $0.id == id } }
    }

    // MARK: Mac desk

    #if os(macOS)
    private var desk: some View {
        NavigationSplitView {
            ProjectSidebar()
                // Every split column gets fixed minimums: wrapped text must never make a column's minimum size
                // depend on its own width (AppKit re-enters constraint updates and terminates the app).
                .frame(minWidth: 220, maxWidth: .infinity, minHeight: 300, maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 220, ideal: 264, max: 320)
        } detail: {
            destinationView(router.destination)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ceStatusStrips()
                .ceBar(.bottom) { dockedComposer }
                // The window's aurora and stage lights, redrawn at the window's size and position: a copy laid out in
                // this column's own frame put its blobs elsewhere and left a seam at the rail's edge.
                .background { WindowAnchoredBackdrop(windowSize: windowSize) }
                // Sidebar max 320 + detail 560 stays inside the window minimum (1040).
                .frame(minWidth: 560, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { detailWidth = $0 }
                // Member detail: a glass drawer over this column on every destination; the rail stays undimmed.
                .overlay { if !store.isArchive { MemberDrawerHost(windowWidth: windowWidth) } }
                // Kept for the Window menu and Mission Control; the toolbar shows `headline` instead (macOS 15+).
                .navigationTitle(store.state?.project.name ?? "IAMCEO")
                .modifier(DeskTitle(subtitle: ""))
                // One look on every tab: the window's aurora shows through the toolbar. Without this, macOS paints its
                // own grey toolbar wherever the content under it is not a scrolled page (대화, 자료).
                .modifier(TransparentWindowToolbar())
                .toolbar {
                    if #available(macOS 26.0, *) {
                        ToolbarItem(placement: .navigation) { headline }
                            .sharedBackgroundVisibility(.hidden)
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                            .sharedBackgroundVisibility(.hidden)
                    } else if #available(macOS 15.0, *) {
                        ToolbarItem(placement: .navigation) { headline }
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                    } else {
                        ToolbarItem(placement: .principal) { DestinationSwitcher(compact: compactTabs) }
                    }
                }
                .background { shortcuts }
                .overlay { MacAttachmentDropSurface(intake: attachmentIntake, policy: attachmentPolicy) }
                .overlay {
                    if attachmentIntake.targeted {
                        let shape = RoundedRectangle(cornerRadius: 22)
                        VStack(spacing: 12) {
                            Image(systemName: attachmentPolicy.canAccept ? "paperclip.circle" : "lock.circle")
                                .font(.system(size: 32))
                            Text(attachmentPolicy.reason ?? "여기에 놓으면 \(attachmentRecipient)에게 보낼 첨부로 올립니다")
                                .font(.system(size: 15, weight: .semibold))
                                .multilineTextAlignment(.center)
                        }
                        .foregroundStyle(CE.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(CE.violet.opacity(0.14), in: shape)
                        .overlay { shape.strokeBorder(CE.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4])) }
                        .padding(8)
                        .allowsHitTesting(false)
                    }
                }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
    }

    private var attachmentRecipient: String {
        router.chatTarget.flatMap { id in store.members.first { $0.id == id }?.name } ?? store.leadRankName
    }

    private var attachmentPolicy: MacAttachmentPolicy {
        MacAttachmentPolicy(archived: store.isArchive || store.state?.project.archived == true,
                            demo: store.isDemo, connected: store.connectionStatus == .connected,
                            writable: store.uiCanWrite && store.selectedProjectID != nil,
                            missingTarget: router.chatTarget != nil && !store.members.contains { $0.id == router.chatTarget },
                            composerCovered: router.memberID != nil)
    }

    /// Web: 108pt tab cells from a 1280pt window up, 92 below (the headline keeps its room).
    private var compactTabs: Bool { windowWidth < 1280 }

    /// Room left of the centred tab pill: half of what the pill leaves, less the toolbar's edge and a gap.
    private var headlineWidth: CGFloat {
        let pill = CGFloat(Destination.allCases.count) * DestinationSwitcher.tabWidth(compact: compactTabs) + 8
        return min(440, max(96, (detailWidth - pill) / 2 - 56))
    }

    /// The project name alone (17/650). The owner asked for no summary line under it on any tab: the current
    /// situation lives on 홈.
    private var headline: some View {
        let name = store.state?.project.name ?? "IAMCEO"
        return Text(name).font(.system(size: 17, weight: .semibold)).tracking(-0.25)
            .foregroundStyle(CE.ink).lineLimit(1).truncationMode(.tail)
        .frame(width: headlineWidth, alignment: .leading)
        .help(name)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// Web composer: centred under the content column (832 = 880 column − 2×24 padding).
    /// While the member drawer is open the composer gives up keyboard focus (disabled; the draft stays in DraftStore),
    /// so keystrokes and Return never reach a field the drawer covers. 지시 closes the drawer first, then focuses it.
    @ViewBuilder private var dockedComposer: some View {
        @Bindable var router = router
        // On 대화 the composer belongs to the thread it sends to, not under the recipients column
        // (ChatView wide layout: 230pt column + 1pt divider).
        let leading: CGFloat = router.destination == .chat && store.state != nil ? 231 : 0
        if !store.isArchive {
            ComposerBar(target: $router.chatTarget, onOpenChat: router.destination == .chat ? nil : { router.go(.chat) })
            .environment(attachmentIntake)
            .disabled(router.memberID != nil)
            .frame(maxWidth: 832)
            .padding(.horizontal, 24).padding(.top, 6).padding(.bottom, 14)
            .frame(maxWidth: .infinity)
            .padding(.leading, leading)
            .background {
                // Violet light behind the glass (web .shell__bottom::after): an ellipse min(760, 110%) wide from the
                // bar's top to 30pt below the window, violet .3 → .12 at 55% → 0, brightest behind the panel's middle.
                GeometryReader { geo in
                    let width = geo.size.width - leading
                    EllipticalGradient(stops: [
                        .init(color: CE.violet.opacity(0.3), location: 0),
                        .init(color: CE.violet.opacity(0.12), location: 0.55),
                        .init(color: CE.violet.opacity(0), location: 1),
                    ])
                    .frame(width: min(760, width * 1.1), height: geo.size.height + 30)
                    .position(x: leading + width / 2, y: (geo.size.height + 30) / 2)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            // Under the light (web ::before under ::after): a dark fade before macOS 26, where there is no
            // scroll-edge effect under the bar.
            .background(alignment: .bottom) {
                if #available(macOS 26.0, *) {} else {
                    LinearGradient(colors: [CE.bg.opacity(0), CE.bg.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    /// ⌘1…⌘5 switch destinations, ⌘R syncs now.
    private var shortcuts: some View {
        ZStack {
            ForEach(Array(Destination.allCases.enumerated()), id: \.element) { index, tab in
                Button(tab.title) { router.go(tab) }.keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
            Button("지금 동기화") { Task { await store.refresh() } }.keyboardShortcut("r", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
    #endif

    // MARK: iPhone / iPad

    #if os(iOS)
    private var phone: some View {
        @Bindable var router = router
        return TabView(selection: $router.destination) {
            ForEach(Destination.allCases) { tab in
                NavigationStack {
                    destinationView(tab)
                        .ceStatusStrips()
                        .background { AmbientBackground() }
                        .navigationTitle(store.state?.project.name ?? "IAMCEO")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button { router.showSettings = true } label: { Image(systemName: "gearshape") }
                                    .accessibilityLabel("설정, \(connectionLabel)")
                            }
                            projectSwitcher(tab)
                            // iOS 26.1+: the bottom accessory pill (named recipient) replaces this button.
                            if !store.isArchive && tab != .chat && !usesComposeAccessory {
                                ToolbarItem(placement: .topBarTrailing) {
                                    Button { router.showCompose = true } label: { Image(systemName: "square.and.pencil") }
                                        .accessibilityLabel("지시 쓰기: \(composeRecipientName)에게")
                                }
                            }
                        }
                }
                .tabItem { Label(tab.title, systemImage: tab.icon) }
                .badge(store.navBadge(for: tab))
                .tag(tab)
            }
        }
        .modifier(QuickComposeAccessory())
    }

    private var connectionLabel: String {
        if store.isDemo { return "샘플 데이터 · 읽기 전용" }
        return store.connectionStatus == .connected ? "서버 연결됨" : "서버 끊김"
    }

    private var usesComposeAccessory: Bool {
        if #available(iOS 26.1, *) { return true }
        return false
    }

    private var composeRecipientName: String {
        guard let id = router.chatTarget else { return store.leadRankName }
        return store.members.first { $0.id == id }?.name ?? "명부에 없는 대상"
    }

    /// Title = project switcher (web phone header). The badge counts what waits in the *other* projects, which the
    /// tab badges (selected project only) cannot show: Σ inboxCount + blockedCount, danger when someone is blocked.
    @ToolbarContentBuilder private func projectSwitcher(_ tab: Destination) -> some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .principal) { projectSwitcherLabel(tab) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { projectSwitcherLabel(tab) }
        }
    }

    private var otherProjectsNeeds: (count: Int, blocked: Bool) {
        let others = store.projects.filter { $0.id != store.selectedProjectID }
        return (others.map { $0.inboxCount + $0.blockedCount }.reduce(0, +), others.contains { $0.blockedCount > 0 })
    }

    private func projectSwitcherLabel(_ tab: Destination) -> some View {
        let name = store.state?.project.name ?? "IAMCEO"
        let others = otherProjectsNeeds
        return Menu { projectMenuItems } label: {
            HStack(spacing: 7) {
                Text(name).font(.headline).foregroundStyle(CE.ink).lineLimit(1)
                CountBadge(count: others.count, tone: others.blocked ? .danger : .accent)
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(CE.ink2)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("프로젝트 \(name)\(others.count > 0 ? ", 다른 프로젝트에서 \(others.count)건이 기다립니다" : ""). 바꾸기")
    }

    @ViewBuilder private var projectMenuItems: some View {
        ForEach(store.projects.filter(\.isHq) + store.projects.filter { !$0.isHq }) { project in
            Button { Task { await store.selectProject(id: project.id) } } label: {
                Label {
                    Text(project.name)
                    Text(projectMenuLine(project))
                } icon: {
                    if project.id == store.selectedProjectID { Image(systemName: "checkmark") }
                }
            }
            .disabled(store.isDemo && project.id != store.selectedProjectID)
        }
        Divider()
        if let id = store.selectedProjectID {
            Button("이름 바꾸기…") { router.manageProject(id: id, mode: .rename) }
                .disabled(store.isDemo || store.connectionStatus != .connected)
            if store.isArchive {
                Button("꺼내기…") { router.manageProject(id: id, mode: .restore) }
                    .disabled(store.isDemo || store.connectionStatus != .connected)
            } else if id != "hq", store.state?.project.isHq != true {
                Button("보관…") { router.manageProject(id: id, mode: .archive) }.disabled(!store.canWrite)
            }
        }
        Button { showArchive = true } label: { Label("보관함", systemImage: "archivebox") }
        Button { router.showNewProject = true } label: { Label("새 프로젝트", systemImage: "plus") }
            .disabled(!store.canWrite)
        Button { router.showSettings = true } label: { Label("설정", systemImage: "gearshape") }
    }

    /// Web projectLine plus what waits on the CEO (the rail's badge, spelled out because a menu has no badge).
    private func projectMenuLine(_ project: ProjectSummary) -> String {
        var parts = [projectRailLine(project)]
        if project.decisionCount > 0 { parts.append("결재 \(project.decisionCount)") }
        if project.todoCount > 0 { parts.append("할 일 \(project.todoCount)") }
        return parts.joined(separator: " · ")
    }
    #endif

    @ViewBuilder private func destinationView(_ tab: Destination) -> some View {
        if store.isArchive { ArchiveView(destination: tab) } else {
            switch tab {
            case .home: HomeView()
            case .inbox: InboxView()
            case .team: TeamView()
            case .chat: ChatView()
            case .files: FilesView()
            }
        }
    }
}

/// Web `projectLine`: one sub-line per project, the state the CEO has to resolve first.
func projectRailLine(_ project: ProjectSummary) -> String {
    if project.blockedCount > 0 { return "승인 창 앞 \(project.blockedCount)명" }
    if project.errorCount > 0 { return "오류 \(project.errorCount)명" }
    if project.workingCount > 0 { return "\(project.workingCount)명 일하는 중" }
    if !project.isHq && !project.runnerEnabled { return "총괄 시작 전" }
    if project.memberCount > 0 { return "\(project.memberCount)명 대기" }
    return "대기"
}

// MARK: - Mac rail

#if os(macOS)
/// Web left rail: brand, 본사, "프로젝트", project rows (name / state line / count badge), 새 프로젝트, then 설정 and the
/// connection mark. The split view's sidebar column supplies the floating glass on macOS 26.
struct ProjectSidebar: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var showArchive = false
    private var hq: [ProjectSummary] { store.projects.filter(\.isHq) }
    private var others: [ProjectSummary] { store.projects.filter { !$0.isHq } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                brand
                ForEach(hq) { row($0) }
                if store.isArchive, let project = store.state?.project {
                    // Same type and insets as a project row (name 14.5/600, sub 12 ink-2, 3pt apart, 7/12).
                    VStack(alignment: .leading, spacing: 3) {
                        Label(project.name, systemImage: "archivebox").font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Text("보관함 · 읽기 전용").font(CEFont.caption).foregroundStyle(CE.ink2).lineLimit(1)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contextMenu {
                        Button("이름 바꾸기…") { router.manageProject(id: project.id, mode: .rename) }
                            .disabled(store.isDemo || store.connectionStatus != .connected)
                        Button("꺼내기…") { router.manageProject(id: project.id, mode: .restore) }
                            .disabled(store.isDemo || store.connectionStatus != .connected)
                    }
                }
                if !others.isEmpty {
                    Text("프로젝트")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink3)
                        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(others) { row($0) }
                // web .pj--add: 42 tall, 14/500 ink-2, ink-1 on hover.
                Button { router.showNewProject = true } label: { quietRow("새 프로젝트", icon: "plus", minHeight: 42) }
                    .buttonStyle(RailRowStyle(quiet: true))
                    .padding(.top, 6)
                    .disabled(!store.canWrite)
            }
            .padding(.horizontal, 8).padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .ceBar(.bottom) { footer }
        .sheet(isPresented: $showArchive) { ArchiveLibraryView() }
    }

    private var brand: some View {
        HStack(spacing: 9) {
            BrandMark(size: 22)
            Text("IAMCEO").font(.system(size: 13.5, weight: .bold)).tracking(0.8).foregroundStyle(CE.ink)
        }
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 12)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ project: ProjectSummary) -> some View {
        let selected = project.id == store.selectedProjectID
        let count = project.inboxCount + project.blockedCount
        let line = projectRailLine(project)
        return Button {
            guard !selected else { return }
            Task { await store.selectProject(id: project.id) }
        } label: {
            HStack(spacing: 10) {
                // web .pj__main: name 14.5/600 and sub 12, both at line-height 1.3, 1px apart (≈ 3pt here).
                VStack(alignment: .leading, spacing: 3) {
                    Text(project.name).font(.system(size: 14.5, weight: .semibold)).tracking(-0.15)
                        .foregroundStyle(CE.ink).lineLimit(1)
                    Text(line).font(CEFont.caption).foregroundStyle(CE.ink2).lineLimit(1)
                }
                Spacer(minLength: 4)
                RailBadge(count: count, danger: project.blockedCount > 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(minHeight: 48)
        }
        .buttonStyle(RailRowStyle(selected: selected))
        .disabled(store.isDemo && !selected)
        .contextMenu {
            Button("이름 바꾸기…") { router.manageProject(id: project.id, mode: .rename) }
                .disabled(store.isDemo || store.connectionStatus != .connected)
            if !project.isHq && project.id != "hq" {
                Button("보관…") { router.manageProject(id: project.id, mode: .archive) }.disabled(!store.canWrite)
            }
        }
        .help(projectStatusLine(project))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(project.name), \(line)\(count > 0 ? ", 확인할 일 \(count)건" : "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// web .pj--foot / .pj--add: icon column 16, label 14/500; ink-2, ink-1 on hover (RailRowStyle quiet).
    private func quietRow(_ title: String, icon: String, minHeight: CGFloat = 40) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 13, weight: .medium)).frame(width: 16)
            Text(title).font(.system(size: 14, weight: .medium)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).frame(minHeight: minHeight)
        .contentShape(Rectangle())
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, 4).padding(.bottom, 4)
            Button { showArchive = true } label: { quietRow("보관함", icon: "archivebox") }
                .buttonStyle(RailRowStyle(quiet: true))
            SettingsLink { quietRow("설정", icon: "gearshape") }
                .buttonStyle(RailRowStyle(quiet: true))
                .help("설정 (⌘,)")
            Button { router.showPairing = true } label: { quietRow("iPhone 연결", icon: "iphone") }
                .buttonStyle(RailRowStyle(quiet: true))
                .help("QR로 iPhone을 이 Mac에 연결합니다")
            connectionMark
        }
        .padding(.horizontal, 8).padding(.bottom, 8)
    }

    /// Web ConnectionMark. Clicking it syncs now (or reconnects); the last sync time is in the tooltip.
    private var connectionMark: some View {
        let state = connectionState
        return Button {
            Task { if store.connectionStatus == .connected { await store.refresh() } else { await store.connect() } }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(state.color).frame(width: 7, height: 7)
                    .shadow(color: state.glow ? state.color.opacity(0.7) : .clear, radius: 4)
                Text(state.text).font(.system(size: 12.5)).foregroundStyle(state.danger ? CE.danger : CE.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if store.isLoading { ProgressView().controlSize(.mini) }
            }
            // web .rail__foot .conn: padding 6 12 8.
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.isDemo)
        .help(connectionHelp)
        .accessibilityLabel(state.text)
        .accessibilityHint(store.isDemo ? "" : store.connectionStatus == .connected ? "지금 동기화" : "다시 연결")
    }

    private var connectionState: (text: String, color: Color, glow: Bool, danger: Bool) {
        if store.isDemo { return ("샘플 데이터 · 읽기 전용", CE.accent, true, false) }
        switch store.connectionStatus {
        case .connected: return (store.localizedSyncDescription, store.realtimeStatus == .fallback ? CE.attention : CE.success, store.realtimeStatus == .live, false)
        case .connecting: return ("서버 연결 중", CE.warn, false, false)
        default: return ("서버 끊김", CE.danger, false, true)
        }
    }

    private var connectionHelp: String {
        if store.isDemo { return "샘플 데이터는 실제 서버에 연결되지 않습니다." }
        guard store.connectionStatus == .connected else { return "눌러서 다시 연결" + (store.connectionIssue.map { " · \($0)" } ?? "") }
        return "눌러서 지금 동기화 (⌘R)" + (store.lastUpdated.map { " · 마지막 \(koTime($0, seconds: true))" } ?? "")
    }
}

/// Web rail badge: violet with white digits, or danger digits on a dark base when someone is at an approval prompt.
private struct RailBadge: View {
    let count: Int
    let danger: Bool
    var body: some View {
        if count > 0 {
            Text("\(count)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
                .foregroundStyle(danger ? CE.danger : Color.white)
                .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                .background {
                    if danger {
                        Capsule().fill(CE.bg.opacity(0.72)).overlay { Capsule().fill(CE.danger.opacity(0.16)) }
                    } else {
                        Capsule().fill(CE.accentFill)
                    }
                }
                .fixedSize()
        }
    }
}

/// Web `.pj` row: hover tint, violet gradient when current, dimmed when disabled. `quiet` rows (web .pj--add,
/// .pj--foot) draw their label in ink-2 and brighten it to ink-1 on hover or press.
private struct RailRowStyle: ButtonStyle {
    var selected = false
    var quiet = false
    func makeBody(configuration: Configuration) -> some View { RailRowBody(configuration: configuration, selected: selected, quiet: quiet) }
    private struct RailRowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        let quiet: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
            let lit = isEnabled && (hovering || configuration.isPressed)
            configuration.label
                .foregroundStyle(quiet && !lit && !selected ? CE.ink2 : CE.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(shape)
                .background {
                    if selected {
                        // web [aria-current]: violet .32 → .2, a 1px white .05 ring and a half-point white .45 line
                        // along the top edge only (inset 0 1px .5px −.5px), not a bright ring down the sides.
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.32), CE.violet.opacity(0.2)], startPoint: .top, endPoint: .bottom))
                            .overlay { shape.strokeBorder(Color.white.opacity(0.05)) }
                            .overlay {
                                shape.strokeBorder(Color.white.opacity(0.45), lineWidth: 0.5)
                                    .mask(alignment: .top) {
                                        LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 10)
                                    }
                            }
                    } else if configuration.isPressed {
                        shape.fill(Color.white.opacity(0.09))
                    } else if hovering && isEnabled {
                        shape.fill(Color.white.opacity(0.06))
                    }
                }
                .animation(.linear(duration: 0.12), value: lit)
                .opacity(isEnabled ? 1 : 0.5)
                .onHover { hovering = $0 }
        }
    }
}

/// Web GlassTabs: one dark glass capsule with count bubbles (홈 = open todos, 결재함 = open decisions + blocked
/// members); the selected tab is a violet glowing drop that slides. Card surface, not Liquid Glass (see `cardPill`).
struct DestinationSwitcher: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Narrow window: 92pt cells instead of 104 (web: 108 incl. pill padding from 1280 up, 92 below).
    var compact = false
    @State private var hovered: Destination?
    @State private var slide = Slide()

    /// web --tab-h is 40 (pill 48); 36 keeps the 44pt pill inside the 52pt unified toolbar.
    static let tabHeight: CGFloat = 36
    static func tabWidth(compact: Bool) -> CGFloat { compact ? 92 : 104 }

    private struct Slide: Equatable { var count = 0; var distance = 1 }
    private struct Squash { var x: CGFloat = 1; var y: CGFloat = 1 }

    private var tabs: [Destination] { Destination.allCases }
    private var tabWidth: CGFloat { Self.tabWidth(compact: compact) }
    private var index: Int { tabs.firstIndex(of: router.destination) ?? 0 }

    var body: some View {
        segments
            // The selected tab's glowing violet drop, behind the labels; it slides from tab to tab.
            .background(alignment: .leading) { drop }
            .padding(4)
            // A little darker than a card: content scrolls under the toolbar.
            .cardPill(tint: 0.62)
            // web .gtabs-glow: a violet light behind the pill that follows the selected tab.
            .background(alignment: .leading) { glow }
            .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.78), value: router.destination)
            .fixedSize()
            .onChange(of: router.destination) { old, new in
                let from = tabs.firstIndex(of: old) ?? 0, to = tabs.firstIndex(of: new) ?? 0
                slide = Slide(count: slide.count + 1, distance: max(1, min(abs(to - from), 3)))
            }
    }

    private var segments: some View {
        HStack(spacing: 0) {
            ForEach(Array(tabs.enumerated()), id: \.element) { position, tab in segment(tab, position: position) }
        }
    }

    private func segment(_ tab: Destination, position: Int) -> some View {
        let selected = router.destination == tab
        let count = store.navBadge(for: tab)
        let detail = store.navBadgeHelp(for: tab)
        // web .gtabs__link: 14.5/600 on every tab (selection changes only the colour, so labels never shift);
        // ink-2, ink-1 on hover.
        return Button { router.go(tab) } label: {
            HStack(spacing: 6) {
                Text(tab.title).font(.system(size: 14.5, weight: .semibold)).tracking(-0.15)
                CountBadge(count: count, tone: .accent)
            }
            .foregroundStyle(selected ? Color.white : hovered == tab ? CE.ink : CE.ink2)
            .animation(.linear(duration: 0.2), value: hovered)
            .frame(width: tabWidth, height: Self.tabHeight)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hovered = tab } else if hovered == tab { hovered = nil }
        }
        .help("\(tab.title)\(detail.map { " · \($0)" } ?? "") (⌘\(position + 1))")
        .accessibilityLabel(count > 0 ? "\(tab.title), \(detail ?? "\(count)건")" : tab.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// One drop for the whole pill, moved by offset: it slides with the spring and, like the web drop, stretches
    /// sideways and flattens while it travels (more for a longer jump). Reduce Motion: no stretch, no slide.
    private var drop: some View {
        let stretch: CGFloat = reduceMotion ? 1 : 1 + 0.16 * CGFloat(slide.distance)
        let flatten: CGFloat = reduceMotion ? 1 : 0.84
        return TabDrop()
            .frame(width: tabWidth, height: Self.tabHeight)
            .keyframeAnimator(initialValue: Squash(), trigger: slide) { content, value in
                content.scaleEffect(x: value.x, y: value.y)
            } keyframes: { _ in
                KeyframeTrack(\.x) {
                    CubicKeyframe(stretch, duration: 0.22)
                    CubicKeyframe(reduceMotion ? 1 : 1.02, duration: 0.21)
                    CubicKeyframe(1, duration: 0.19)
                }
                KeyframeTrack(\.y) {
                    CubicKeyframe(flatten, duration: 0.22)
                    CubicKeyframe(reduceMotion ? 1 : 0.98, duration: 0.21)
                    CubicKeyframe(1, duration: 0.19)
                }
            }
            .offset(x: CGFloat(index) * tabWidth)
    }

    /// web: radial violet .56 → .22 at 48% → 0, 2/n of the pill + 90 wide, 3.1 tab heights tall, centred on the tab.
    /// The toolbar may cut it at its edge; it is faint there.
    private var glow: some View {
        let pill = CGFloat(tabs.count) * tabWidth + 8
        let width = 2 * pill / CGFloat(tabs.count) + 90
        return EllipticalGradient(stops: [
            .init(color: CE.violet.opacity(0.56), location: 0),
            .init(color: CE.violet.opacity(0.22), location: 0.48),
            .init(color: CE.violet.opacity(0), location: 1),
        ])
        .frame(width: width, height: Self.tabHeight * 3.1)
        .offset(x: 4 + (CGFloat(index) + 0.5) * tabWidth - width / 2)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Mac member drawer

/// Member detail on Mac: a drawer floating at the trailing edge of the content column, inset like the rail and in the
/// rail's dark violet, over a light scrim. Driven by `router.memberID` (home rows, office desks, chat, files, inbox,
/// `--open`). The scrim, Esc, the close button and switching screens all clear it.
private struct MemberDrawerHost: View {
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let windowWidth: CGFloat

    private var width: CGFloat { min(max(windowWidth * 0.4, 440), 560) }

    var body: some View {
        let open = router.memberID != nil
        ZStack(alignment: .trailing) {
            if open {
                // Stops at the toolbar: the tabs stay live (switching screens closes the drawer), so they stay undimmed.
                Color.black.opacity(0.14)
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .transition(.opacity)
                    .accessibilityHidden(true)
            }
            if let id = router.memberID {
                MemberDrawer(memberID: id, width: width, onClose: close)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: open)
    }

    private func close() { router.memberID = nil }
}

private struct MemberDrawer: View {
    let memberID: String
    let width: CGFloat
    let onClose: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        // Fresh state per member: switching member in place must not show the previous one's activity.
        MemberDetailView(memberID: memberID, onClose: onClose)
            .id(memberID)
            .environment(\.ceInsideGlass, true)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .clipShape(shape)
            .modifier(DrawerSurface(shape: shape))
            .contentShape(shape)
            .onExitCommand(perform: onClose)
            // Esc also works while the focus sits outside the drawer (the docked composer, nothing at all).
            .background {
                Button("닫기", action: onClose)
                    .keyboardShortcut(.cancelAction)
                    .opacity(0).frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            .padding(10)
    }
}

/// The drawer's surface: the rail's dark violet, a quiet white rim and a soft, wide shadow, so it reads as the rail's
/// sibling in the same window. It is a reading panel, so it is opaque on every path: nothing behind it (office cards,
/// the work list, the content column's edge) ever shows through its text. On macOS 26 a lightly tinted clear glass
/// sits on the opaque backing only for the glass edge light the rail has; it shades the colour, never reveals.
private struct DrawerSurface<S: InsettableShape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let shape: S

    /// What the empty drawer shows: the rail's dark violet (on screen both sample ≈ rgb 30 29 45; plates one step up).
    /// Used as is when there is no glass (before macOS 26, Reduce Transparency).
    static var surface: Color { Color(hex: 0x201F34) }
    /// macOS 26 backing under the glass. The tinted clear glass darkens and greys what it sits on (measured on screen:
    /// ≈ 17 + 0.42 × backing per channel), so the backing is a little bluer than `surface` and lands on the same colour.
    /// `.regular` glass is not used: it lifts every backing by ≈ +35 into a neutral grey, lighter than the rail.
    static var glassBacking: Color { Color(hex: 0x21203C) }

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *), !reduceTransparency {
            content
                .glassEffect(.clear.tint(CE.glassTint.opacity(0.4)), in: shape)
                .background { backing(Self.glassBacking) }
                .overlay { rim }
        } else {
            content
                .background { backing(Self.surface) }
                .overlay { rim }
        }
    }

    /// The shadow belongs to the panel outline only: on the whole drawer every line of text and every button would
    /// cast its own smudge onto the surface.
    private func backing(_ color: Color) -> some View {
        shape.fill(color).shadow(color: Color.black.opacity(0.35), radius: 30, y: 12)
    }

    private var rim: some View {
        shape.strokeBorder(Color.white.opacity(0.08)).allowsHitTesting(false)
    }
}

// MARK: - Mac window title and backdrop

/// macOS 15+: the system title leaves the toolbar (the window keeps it for the Window menu), and the custom headline
/// takes its place. macOS 14 keeps the system title and shows the now line as its subtitle.
private struct DeskTitle: ViewModifier {
    let subtitle: String
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content.navigationSubtitle(subtitle)
        }
    }
}

/// Web shell stage lights (LocalLight): violet at (60%, 0) min(980, 80%) wide, aspect .42, strength .34; orchid at
/// (66%, 100%) min(860, 70%) wide, aspect .38, strength .28; each a, a × .42 at 45%, 0. Laid out in window
/// coordinates like the web stage, which spans under the rail.
private struct StageLights: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            if !reduceTransparency {
                ZStack {
                    light(CE.violet, strength: 0.34, width: min(980, w * 0.8), aspect: 0.42)
                        .position(x: w * 0.6, y: 0)
                    light(CE.orchid, strength: 0.28, width: min(860, w * 0.7), aspect: 0.38)
                        .position(x: w * 0.66, y: h)
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func light(_ color: Color, strength a: Double, width: CGFloat, aspect: CGFloat) -> some View {
        EllipticalGradient(stops: [
            .init(color: color.opacity(a), location: 0),
            .init(color: color.opacity(a * 0.42), location: 0.45),
            .init(color: color.opacity(0), location: 1),
        ])
        .frame(width: width, height: width * aspect)
    }
}

/// The window's backdrop (aurora + stage lights) drawn at the window's size, shifted so it lines up with the copy
/// behind the rail: the detail column is the window's trailing, bottom-aligned part, so the shift is the size
/// difference. Clipped to the column. Until the window has been measured it falls back to the column's own frame.
private struct WindowAnchoredBackdrop: View {
    let windowSize: CGSize
    var body: some View {
        GeometryReader { geo in
            if windowSize.width > 0, windowSize.height > 0 {
                backdrop
                    .frame(width: windowSize.width, height: windowSize.height)
                    .offset(x: geo.size.width - windowSize.width, y: geo.size.height - windowSize.height)
            } else {
                backdrop
            }
        }
        .ignoresSafeArea()
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var backdrop: some View {
        ZStack {
            AmbientBackground()
            StageLights()
        }
    }
}
#endif

// MARK: - Status strips shared by both platforms

extension View {
    /// Global strips (lost connection, last error; sample mode on iPhone). Attach to every destination root and to
    /// every screen pushed on iPhone, so read-only mode, a lost connection and a failed write stay visible everywhere.
    func ceStatusStrips() -> some View { ceBar(.top) { StatusStrips() } }
}

/// Thin rounded strips inside the content column (web OfflineBand / notice band). On Mac the text stays on one line
/// (full text in the tooltip): wrapped text in a bar outside a scroll view must not size the split view.
struct StatusStrips: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dismissedNotice: String?
    /// Web OfflineBand waits 1.5 s before it shows: a short blip (window back in front, server restart) never
    /// flashes the strip. The composer says at once that it cannot send.
    @State private var offlineShown = false

    private var offline: Bool { store.connectionStatus != .connected && !store.isDemo && store.bootstrap != nil }

    private struct Strip: Identifiable {
        let id: String
        let tone: Tone
        let icon: String
        let text: String
        var detail: String? = nil
        var actionTitle: String? = nil
        var action: (() -> Void)? = nil
    }

    private var strips: [Strip] {
        var items: [Strip] = []
        // Mac shows sample mode in the rail's connection mark and on the composer, so no strip there.
        if store.isDemo && !isMac {
            items.append(Strip(id: "demo", tone: .accent, icon: "eye", text: "샘플 데이터 · 읽기 전용"))
        }
        if offline && offlineShown {
            items.append(Strip(id: "offline", tone: .attention, icon: "wifi.slash", text: "서버와 연결이 끊겼습니다. 다시 잇는 중입니다.",
                               detail: store.connectionIssue, actionTitle: "지금 다시 연결", action: { Task { await store.connect() } }))
        }
        if store.isArchive {
            items.append(Strip(id: "archive", tone: .neutral, icon: "archivebox", text: "보관한 프로젝트 · 읽기 전용",
                               actionTitle: "관리", action: {
                if let id = store.selectedProjectID { router.manageProject(id: id, mode: .restore) }
            }))
        }
        if store.connectionStatus == .connected && !store.isDemo && store.realtimeStatus == .fallback {
            items.append(Strip(id: "fallback", tone: .attention, icon: "arrow.triangle.2.circlepath", text: store.localizedSyncDescription,
                               actionTitle: "지금 다시 연결", action: { Task { await store.connect() } }))
        }
        if let notice = router.navigationNotice ?? store.notificationNotice ?? store.projectNotice, notice != dismissedNotice {
            items.append(Strip(id: "notice", tone: .neutral, icon: "info.circle", text: notice,
                               actionTitle: "닫기", action: { dismissedNotice = notice; router.navigationNotice = nil }))
        }
        if let error = store.errorMessage {
            items.append(Strip(id: "error", tone: .danger, icon: "exclamationmark.circle", text: error,
                               actionTitle: "닫기", action: { store.errorMessage = nil }))
        }
        return items
    }

    var body: some View {
        let items = strips
        // Always present (zero height when empty), so strips slide in and out instead of making the content jump.
        // Padding before the cap: the strips are as wide as the 832pt content column and the docked composer.
        VStack(spacing: 6) {
            ForEach(items) { item in
                strip(item).transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, isMac ? 24 : 14)
        .padding(.top, items.isEmpty ? 0 : 4).padding(.bottom, items.isEmpty ? 0 : 6)
        .frame(maxWidth: 880)
        .frame(maxWidth: .infinity)
        .animation(.easeOut(duration: 0.2), value: items.map(\.id))
        .task(id: offline) {
            guard offline else { offlineShown = false; return }
            try? await Task.sleep(for: .milliseconds(1500))
            if !Task.isCancelled { offlineShown = true }
        }
    }

    /// web .offline-band: an opaque dark plate (not glass), readable over any light. The connection strips use the
    /// web's warm plate; the others the app's dark plate tinted by their tone.
    private struct Palette {
        let warm: Bool
        let tone: Tone
        var text: Color { warm ? Color(hex: 0xFFE3BC) : CE.ink }
        var action: Color { warm ? Color(hex: 0xFFF3E2) : CE.ink }
        var ring: Color { warm ? CE.warn.opacity(0.34) : tone.color.opacity(0.34) }
    }

    private func strip(_ item: Strip) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        let full = item.detail.map { "\(item.text) (\($0))" } ?? item.text
        let palette = Palette(warm: item.tone == .attention, tone: item.tone)
        let hasAction = item.actionTitle != nil && item.action != nil
        return HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: item.icon).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(item.tone.color)
                // web 13.5px at line-height 1.35.
                Text(item.text).font(CEFont.note).foregroundStyle(palette.text)
                    .lineSpacing(CELeading.spacing(13.5, 1.35))
                    .lineLimit(isMac ? 1 : 2).truncationMode(.tail)
            }
            Spacer(minLength: 6)
            if let title = item.actionTitle, let action = item.action {
                Button(title, action: action)
                    .buttonStyle(StripActionStyle(color: palette.action))
                    .fixedSize()
            }
        }
        // web: padding 8 8 8 14 around a 32pt button. iPhone: the button's 44pt hit area sets the height.
        .padding(.leading, 14).padding(.trailing, hasAction ? 8 : 14)
        .padding(.vertical, hasAction && !isMac ? 2 : 8)
        .background {
            ZStack {
                if palette.warm {
                    shape.fill(Color(red: 58 / 255, green: 28 / 255, blue: 16 / 255).opacity(0.94))
                } else {
                    shape.fill(CE.bg.opacity(0.9))
                    shape.fill(item.tone.color.opacity(0.13))
                }
            }
            // web 0 8px 24px −12px rgb(4 2 14 / .8): lifts the plate off the content passing under it.
            .shadow(color: Color(red: 4 / 255, green: 2 / 255, blue: 14 / 255).opacity(0.55), radius: 10, y: 8)
        }
        .overlay { shape.strokeBorder(palette.ring) }
        .help(full)
        .accessibilityElement(children: .combine)
    }
}

/// web .offline-band__retry: 32pt capsule, 13/600, white .10 → .17 on hover.
private struct StripActionStyle: ButtonStyle {
    let color: Color
    func makeBody(configuration: Configuration) -> some View { StripActionBody(configuration: configuration, color: color) }
    private struct StripActionBody: View {
        let configuration: ButtonStyleConfiguration
        let color: Color
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(isMac ? .system(size: 13, weight: .semibold) : CEFont.secondary.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .padding(.horizontal, 12).frame(height: 32)
                .background(Color.white.opacity(configuration.isPressed ? 0.22 : hovering ? 0.17 : 0.1), in: Capsule())
                .animation(.linear(duration: 0.12), value: hovering)
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

// MARK: - iPhone quick compose

#if os(iOS)
/// iOS 26.1+: a pill above the tab bar that names the recipient ("결제 연동에게 지시…") on every tab except 대화, which
/// has its own inline composer. On a member's page it addresses that member.
private struct QuickComposeAccessory: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    func body(content: Content) -> some View {
        if #available(iOS 26.1, *) {
            content.tabViewBottomAccessory(isEnabled: router.destination != .chat && !store.isArchive) { QuickComposePill() }
        } else {
            content
        }
    }
}

struct QuickComposePill: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts

    /// The member open on 팀 (pushed detail) when there is one, else the shared chat target.
    private var contextTarget: String? {
        if router.destination == .team, let id = router.memberID, let member = store.members.first(where: { $0.id == id }) {
            return member.kind == "worker" ? member.id : nil
        }
        return router.chatTarget
    }

    var body: some View {
        let target = contextTarget
        let member = target.flatMap { id in store.members.first { $0.id == id } }
        let name = member?.name ?? (target == nil ? store.leadRankName : "명부에 없는 대상")
        let key = DraftStore.key(project: store.selectedProjectID, target: target)
        let hasDraft = !drafts.text(for: key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.files(for: key).isEmpty
        Button {
            router.chatTarget = target
            router.showCompose = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").foregroundStyle(CE.accent)
                Text("\(name)에게 지시…").font(CEFont.secondary).foregroundStyle(CE.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if hasDraft { Text("작성 중").font(CEFont.micro).foregroundStyle(CE.attention) }
            }
            .padding(.horizontal, CESpace.l)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name)에게 지시 쓰기\(hasDraft ? ", 작성 중인 글 있음" : "")")
    }
}
#endif

struct QuickComposeSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    @Environment(\.dismiss) private var dismiss
    @State private var closeTask: Task<Void, Never>?
    var body: some View {
        @Bindable var router = router
        NavigationStack {
            VStack(spacing: 0) {
                // The sheet stays open long enough to show the result (sent, or why it failed with the text kept).
                ComposerBar(target: $router.chatTarget, autoFocus: true,
                            onSent: { scheduleClose() },
                            onOpenChat: { closeTask?.cancel(); dismiss(); router.go(.chat) },
                            onSwipeDown: { closeTask?.cancel(); dismiss() })
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.top, 8)
            // The empty space under the composer closes the sheet with a downward swipe too (the system swipe only
            // works on the title bar while the keyboard is up).
            .contentShape(Rectangle())
            .simultaneousGesture(DragGesture(minimumDistance: 12).onEnded { value in
                guard value.translation.height > 40, value.translation.height > abs(value.translation.width) * 1.2 else { return }
                closeTask?.cancel(); dismiss()
            })
            .background { AmbientBackground() }
            .navigationTitle("지시 쓰기")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onDisappear { closeTask?.cancel() }
    }

    /// Close after the sent notice was readable, unless the CEO already started the next instruction.
    private func scheduleClose() {
        closeTask?.cancel()
        closeTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            let key = DraftStore.key(project: store.selectedProjectID, target: router.chatTarget)
            guard drafts.text(for: key).isEmpty, drafts.files(for: key).isEmpty else { return }
            dismiss()
        }
    }
}

extension AppStore {
    /// Writes need a live connection and a healthy project runner connection. In-flight requests are not a global
    /// lock: each control checks its own `pendingActions` key (mutate() already de-duplicates per key), so a
    /// 150 s member respawn never blocks instructions to everyone else.
    var uiCanWrite: Bool { canWrite && state?.project.connection.ok == true }

    var localizedSyncDescription: String {
        if isDemo { return "샘플 데이터 · 읽기 전용" }
        switch realtimeStatus {
        case .paused: return "앱이 비활성 상태여서 동기화를 쉬고 있습니다"
        case .connecting: return "실시간 연결 중…"
        case .syncing: return "최신 상태를 불러오는 중…"
        case .live: return "실시간으로 연결됨"
        case .legacy: return "연결됨 · 이전 방식으로 변경 확인"
        case .fallback: return "실시간 연결이 끊겨 주기적으로 확인하고 있습니다"
        case .blocked: return "서버 주소나 접근 허용 설정을 확인해 주세요"
        }
    }

    /// Rank name of the member who receives messages with no explicit target (총괄, or 본사 AI on HQ).
    var leadRankName: String { members.first { $0.kind == "conductor" || $0.kind == "root" }.map { rankName($0.kind) } ?? "총괄" }

    /// Destination badges always equal a number visible on that destination (same rule as the web tabs):
    /// 결재함 = open decisions + members at an approval prompt (both listed there); 홈 = open todos (its 할 일 counter).
    func navBadge(for tab: Destination) -> Int {
        if isArchive { return 0 }
        return switch tab {
        case .inbox: decisions.filter { $0.status == "open" }.count + members.filter { $0.status == "blocked" }.count
        case .home: todos.filter { !$0.done }.count
        default: 0
        }
    }

    func navBadgeHelp(for tab: Destination) -> String? {
        switch tab {
        case .inbox:
            let open = decisions.filter { $0.status == "open" }.count
            let blocked = members.filter { $0.status == "blocked" }.count
            guard open + blocked > 0 else { return nil }
            return [open > 0 ? "결재 \(open)건" : nil, blocked > 0 ? "승인 창 앞 \(blocked)명" : nil].compactMap { $0 }.joined(separator: " · ")
        case .home:
            let todos = todos.filter { !$0.done }.count
            return todos > 0 ? "내 할 일 \(todos)건" : nil
        default: return nil
        }
    }
}

/// The window toolbar draws no background of its own (macOS 15+), so every tab shows the same aurora under it.
private struct TransparentWindowToolbar: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
        if #available(macOS 15.0, *) {
            content.toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        } else {
            content
        }
        #else
        content
        #endif
    }
}
