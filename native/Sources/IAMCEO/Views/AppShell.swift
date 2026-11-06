import SwiftUI

/// App frame, after the web shell the owner likes: Mac = glass rail (projects) + title + centred glass tabs + docked
/// composer; iPhone = project title menu + tab bar with badges + compose access. On Mac the member detail is a glass
/// drawer inside the window (a sibling of the rail), not a system sheet.
struct AppShell: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    /// Window width, for the member drawer's width (36% of the window, 400…480).
    @State private var windowWidth: CGFloat = 1440
    #endif
    private var needsConnection: Bool { store.bootstrap == nil && !store.isDemo }

    var body: some View {
        @Bindable var router = router
        ZStack {
            AmbientBackground()
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
            guard let link = PairingLink(url: url) else { return }
            #if os(iOS)
            Task { await store.pair(with: link, device: UIDevice.current.name) }
            #else
            store.errorMessage = "이 링크는 iPhone에서 여는 연결 QR입니다."
            _ = link
            #endif
        }
        // Foreground/background polling is driven by the App's aggregate scene phase (IAMCEOApp).
        .onChange(of: store.selectedProjectID) { _, _ in router.resetForProjectChange() }
        // The store is shared by every window: a window that appears later (second iPad window, Mac window reopened
        // after ⌘W) must not tear down a live or in-progress connection.
        .task {
            guard !store.isDemo, store.bootstrap == nil, store.connectionStatus != .connecting,
                  !store.endpoint.isEmpty, !store.accessCode.isEmpty else { return }
            await store.connect()
        }
    }

    /// Terminal sheet from the window root, on both platforms. The Mac member drawer lives inside the window, so the
    /// terminal it opens is presented here too and stays open if the drawer closes.
    private var rootTerminal: Binding<Member?> {
        Binding(get: { terminalMember }, set: { router.terminalMemberID = $0?.id })
    }

    private var terminalMember: Member? {
        router.terminalMemberID.flatMap { id in store.members.first { $0.id == id } }
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
                .background { AmbientBackground() }
                // Sidebar max 320 + detail 560 stays inside the window minimum (1040).
                .frame(minWidth: 560, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
                // Member detail: a glass drawer over this column on every destination; the rail stays undimmed.
                .overlay { MemberDrawerHost(windowWidth: windowWidth) }
                .navigationTitle(store.state?.project.name ?? "IAMCEO")
                .navigationSubtitle(deskSubtitle)
                .toolbar {
                    if #available(macOS 26.0, *) {
                        ToolbarItem(placement: .principal) { DestinationSwitcher() }
                            .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .principal) { DestinationSwitcher() }
                    }
                }
                .background { shortcuts }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
    }

    /// Web composer: centred under the content column (832 = 880 column − 2×24 padding).
    /// While the member drawer is open the composer gives up keyboard focus (disabled; the draft stays in DraftStore),
    /// so keystrokes and Return never reach a field the drawer covers. 지시 closes the drawer first, then focuses it.
    private var dockedComposer: some View {
        @Bindable var router = router
        return ComposerBar(target: $router.chatTarget, onOpenChat: router.destination == .chat ? nil : { router.go(.chat) })
            .disabled(router.memberID != nil)
            .frame(maxWidth: 832)
            .padding(.horizontal, 24).padding(.top, 6).padding(.bottom, 14)
            .frame(maxWidth: .infinity)
            // On 대화 the composer belongs to the thread it sends to, not under the recipients column
            // (ChatView wide layout: 230pt column + 1pt divider).
            .padding(.leading, router.destination == .chat && store.state != nil ? 231 : 0)
            .background(alignment: .bottom) {
                // Violet light behind the glass (web .shell__bottom::after), plus a dark fade before macOS 26,
                // where there is no scroll-edge effect under the bar.
                ZStack(alignment: .bottom) {
                    if #available(macOS 26.0, *) {} else {
                        LinearGradient(colors: [CE.bg.opacity(0), CE.bg.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                    }
                    RadialGradient(colors: [CE.violet.opacity(0.22), CE.violet.opacity(0.08), .clear], center: .bottom, startRadius: 0, endRadius: 420)
                        .frame(maxWidth: 900)
                }
                .allowsHitTesting(false)
            }
    }

    /// The selected destination is already shown by the tabs. Like the web header, 결재함·대화·자료 carry the
    /// project's `now` line; 홈 and 팀 show it in their own content.
    private var deskSubtitle: String {
        guard [.inbox, .chat, .files].contains(router.destination), let now = store.state?.project.now else { return "" }
        return plainOneLine(now)
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
                            projectSwitcher
                            // iOS 26.1+: the bottom accessory pill (named recipient) replaces this button.
                            if tab != .chat && !usesComposeAccessory {
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
    @ToolbarContentBuilder private var projectSwitcher: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .principal) { projectSwitcherLabel }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { projectSwitcherLabel }
        }
    }

    private var otherProjectsNeeds: (count: Int, blocked: Bool) {
        let others = store.projects.filter { $0.id != store.selectedProjectID }
        return (others.map { $0.inboxCount + $0.blockedCount }.reduce(0, +), others.contains { $0.blockedCount > 0 })
    }

    private var projectSwitcherLabel: some View {
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
        switch tab {
        case .home: HomeView()
        case .inbox: InboxView()
        case .team: TeamView()
        case .chat: ChatView()
        case .files: FilesView()
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
    private var hq: [ProjectSummary] { store.projects.filter(\.isHq) }
    private var others: [ProjectSummary] { store.projects.filter { !$0.isHq } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                brand
                ForEach(hq) { row($0) }
                if !others.isEmpty {
                    Text("프로젝트")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink3)
                        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
                        .accessibilityAddTraits(.isHeader)
                }
                ForEach(others) { row($0) }
                Button { router.showNewProject = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                        Text("새 프로젝트")
                    }
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(CE.ink2)
                    .padding(.horizontal, 12).frame(minHeight: 42)
                }
                .buttonStyle(RailRowStyle())
                .padding(.top, 6)
                .disabled(!store.canWrite)
            }
            .padding(.horizontal, 8).padding(.bottom, 8)
        }
        .scrollIndicators(.never)
        .ceBar(.bottom) { footer }
    }

    private var brand: some View {
        HStack(spacing: 9) {
            Capsule()
                .fill(LinearGradient(colors: [Color(hex: 0xCDBEFF), Color(hex: 0x7A5BFF)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 18, height: 10)
                .shadow(color: CE.violet.opacity(0.6), radius: 6)
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
                VStack(alignment: .leading, spacing: 1) {
                    Text(project.name).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(CE.ink).lineLimit(1)
                    Text(line).font(.system(size: 12)).foregroundStyle(CE.ink2).lineLimit(1)
                }
                Spacer(minLength: 4)
                RailBadge(count: count, danger: project.blockedCount > 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(minHeight: 48)
        }
        .buttonStyle(RailRowStyle(selected: selected))
        .disabled(store.isDemo && !selected)
        .help(projectStatusLine(project))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(project.name), \(line)\(count > 0 ? ", 확인할 일 \(count)건" : "")")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, 4).padding(.bottom, 4)
            SettingsLink {
                Text("설정").font(.system(size: 14, weight: .medium)).foregroundStyle(CE.ink2)
                    .padding(.horizontal, 12).frame(minHeight: 40)
            }
            .buttonStyle(RailRowStyle())
            .help("설정 (⌘,)")
            Button { router.showPairing = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "iphone").font(.system(size: 13))
                    Text("iPhone 연결").font(.system(size: 14, weight: .medium))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(CE.ink2)
                .padding(.horizontal, 12).frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(RailRowStyle())
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
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 4)
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
        case .connected: return ("서버 연결됨", CE.success, true, false)
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

/// Web `.pj` row: hover tint, violet gradient when current, dimmed when disabled.
private struct RailRowStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View { RailRowBody(configuration: configuration, selected: selected) }
    private struct RailRowBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 13, style: .continuous)
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(shape)
                .background {
                    if selected {
                        shape.fill(LinearGradient(colors: [CE.violet.opacity(0.32), CE.violet.opacity(0.2)], startPoint: .top, endPoint: .bottom))
                            .overlay {
                                shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.32), Color.white.opacity(0.05)], startPoint: .top, endPoint: .bottom), lineWidth: 1)
                            }
                    } else if configuration.isPressed {
                        shape.fill(Color.white.opacity(0.09))
                    } else if hovering && isEnabled {
                        shape.fill(Color.white.opacity(0.06))
                    }
                }
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
    @Namespace private var dropSpace

    var body: some View {
        segments
            .padding(4)
            // A little darker than a card: content scrolls under the toolbar.
            .cardPill(tint: 0.62)
            .animation(.spring(response: 0.45, dampingFraction: 0.78), value: router.destination)
            .fixedSize()
    }

    private var segments: some View {
        HStack(spacing: 0) {
            ForEach(Destination.allCases) { tab in segment(tab) }
        }
    }

    private func segment(_ tab: Destination) -> some View {
        let selected = router.destination == tab
        let count = store.navBadge(for: tab)
        let label = HStack(spacing: 6) {
            Text(tab.title).font(.system(size: 13.5, weight: selected ? .semibold : .medium))
            CountBadge(count: count, tone: .accent)
        }
        .foregroundStyle(selected ? Color.white : CE.ink2)
        .frame(width: 92, height: 32)
        .contentShape(Capsule())
        return Button { router.go(tab) } label: {
            if selected { drop(label) } else { label }
        }
        .buttonStyle(.plain)
        .help(store.navBadgeHelp(for: tab) ?? tab.title)
        .accessibilityLabel(count > 0 ? "\(tab.title), \(store.navBadgeHelp(for: tab) ?? "\(count)건")" : tab.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// The selected tab's glowing violet drop, behind the label; it slides from tab to tab.
    private func drop<Label: View>(_ label: Label) -> some View {
        label.background { TabDrop().matchedGeometryEffect(id: "drop", in: dropSpace) }
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

    private var width: CGFloat { min(max(windowWidth * 0.36, 400), 480) }

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
        if store.connectionStatus != .connected && !store.isDemo && store.bootstrap != nil {
            items.append(Strip(id: "offline", tone: .attention, icon: "wifi.slash", text: "서버와 연결이 끊겼습니다. 다시 잇는 중입니다.",
                               detail: store.connectionIssue, actionTitle: "지금 다시 연결", action: { Task { await store.connect() } }))
        }
        if let error = store.errorMessage {
            items.append(Strip(id: "error", tone: .danger, icon: "exclamationmark.circle", text: error,
                               actionTitle: "닫기", action: { store.errorMessage = nil }))
        }
        return items
    }

    var body: some View {
        let items = strips
        if !items.isEmpty {
            VStack(spacing: 6) {
                ForEach(items) { strip($0) }
            }
            .frame(maxWidth: 880)
            .padding(.horizontal, isMac ? 24 : 14).padding(.top, 4).padding(.bottom, 6)
            .frame(maxWidth: .infinity)
        }
    }

    private func strip(_ item: Strip) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        let full = item.detail.map { "\(item.text) (\($0))" } ?? item.text
        return HStack(spacing: 10) {
            Image(systemName: item.icon).font(.system(size: 12, weight: .semibold)).foregroundStyle(item.tone.color)
            Text(item.text).font(CEFont.secondary).foregroundStyle(CE.ink)
                .lineLimit(isMac ? 1 : 2).truncationMode(.tail)
            Spacer(minLength: 6)
            if let title = item.actionTitle, let action = item.action {
                Button(action: action) {
                    Text(title).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink)
                        .padding(.horizontal, 12).frame(height: 28)
                        .background(Color.white.opacity(0.1), in: Capsule())
                        .frame(minHeight: isMac ? nil : 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .fixedSize()
            }
        }
        .padding(.leading, 14).padding(.trailing, item.action == nil ? 14 : 5).padding(.vertical, item.action == nil || isMac ? 6 : 0)
        .background {
            shape.fill(CE.bg.opacity(0.88))
            shape.fill(item.tone.color.opacity(0.13))
        }
        .overlay { shape.strokeBorder(item.tone.color.opacity(0.34)) }
        .help(full)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - iPhone quick compose

#if os(iOS)
/// iOS 26.1+: a pill above the tab bar that names the recipient ("결제 연동에게 지시…") on every tab except 대화, which
/// has its own inline composer. On a member's page it addresses that member.
private struct QuickComposeAccessory: ViewModifier {
    @Environment(Router.self) private var router
    func body(content: Content) -> some View {
        if #available(iOS 26.1, *) {
            content.tabViewBottomAccessory(isEnabled: router.destination != .chat) { QuickComposePill() }
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
                            onOpenChat: { closeTask?.cancel(); dismiss(); router.go(.chat) })
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.top, 8)
            .background { AmbientBackground() }
            .navigationTitle("지시 쓰기")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
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
    var uiCanWrite: Bool { connectionStatus == .connected && !isDemo && state?.project.connection.ok == true }

    /// Rank name of the member who receives messages with no explicit target (총괄, or 본사 AI on HQ).
    var leadRankName: String { members.first { $0.kind == "conductor" || $0.kind == "root" }.map { rankName($0.kind) } ?? "총괄" }

    /// Destination badges always equal a number visible on that destination (same rule as the web tabs):
    /// 결재함 = open decisions + members at an approval prompt (both listed there); 홈 = open todos (its 할 일 counter).
    func navBadge(for tab: Destination) -> Int {
        switch tab {
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
