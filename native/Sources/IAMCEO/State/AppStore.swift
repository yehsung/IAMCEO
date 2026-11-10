import Foundation
import Observation
import Network
import OSLog
#if os(iOS)
import UIKit

@MainActor private final class TerminalReleaseBackgroundTask {
    private var id: UIBackgroundTaskIdentifier = .invalid
    init() {
        id = UIApplication.shared.beginBackgroundTask(withName: "Release terminal control") { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }
    func end() {
        guard id != .invalid else { return }
        let current = id
        id = .invalid
        UIApplication.shared.endBackgroundTask(current)
    }
}
#endif

enum ConnectionStatus: String, Sendable { case disconnected, connecting, connected, demo, failed }
enum RealtimeStatus: String, Sendable { case paused, connecting, syncing, live, legacy, fallback, blocked }

private struct RefreshScope: OptionSet {
    let rawValue: Int
    static let snapshot = Self(rawValue: 1)
    static let history = Self(rawValue: 2)
    static let delivery = Self(rawValue: 4)
    static let activity = Self(rawValue: 8)
    static let diagnostics = Self(rawValue: 16)
    static let archive = Self(rawValue: 32)
    static let all: Self = [.snapshot, .history, .delivery, .activity]
}

private struct AppliedSyncIdentity: Equatable {
    let selection: UUID
    let cursor: SyncCursor
    let revisions: SyncRevisions?
    let projectStatus: SyncProjectStatus
}

@MainActor @Observable
final class AppStore: ProjectManagementStore {
    var endpoint: String
    var accessCode: String
    /// Captured at launch; typing credentials must never turn first-time setup into recovery.
    private(set) var restoredCredentials = false
    private(set) var connectionStatus: ConnectionStatus = .disconnected
    // Keep the server reason available for internal decisions; only the UI getter translates it.
    private(set) var rawErrorMessage: String?
    var errorMessage: String? {
        get { rawErrorMessage.map(TerminalPresentation.message) }
        set { rawErrorMessage = newValue }
    }
    private var messageSendNotices: [String: String] = [:]
    func messageSendNotice(targetMemberID: String?) -> String? {
        messageSendNotices[Self.scoped(writeNamespace, DraftStore.key(project: selectedProjectID, target: targetMemberID))]
    }
    func explainMessageSendBlock(_ reason: String, targetMemberID: String?) {
        messageSendNotices[Self.scoped(writeNamespace, DraftStore.key(project: selectedProjectID, target: targetMemberID))] = reason
    }
    let terminalWake = TerminalWake()
    private(set) var isLoading = false
    /// A QR pairing claim is in flight (phone).
    private(set) var isPairing = false
    private(set) var pendingActions: Set<String> = []
    private(set) var terminalLeases: [String: TerminalLease] = [:]
    private(set) var apiOutage: APIOutage?
    private(set) var bootstrap: Bootstrap?
    private(set) var runtime: RuntimeDiagnostics?
    private(set) var selectedProjectID: String?
    private(set) var state: ProjectState? {
        didSet { updateStateCollections() }
    }
    private(set) var lastUpdated: Date?
    private(set) var api: APIClient?
    private(set) var modelCatalog: ModelCatalog = .fallback
    @ObservationIgnored private var modelsTask: Task<ModelCatalog, Error>?
    @ObservationIgnored private var modelsRequestID = UUID()
    let isDemo: Bool
    var projects: [ProjectSummary] { bootstrap?.projects ?? [] }
    private(set) var messages: [Message] = []
    private(set) var members: [Member] = []
    private(set) var decisions: [Decision] = []
    private(set) var todos: [Todo] = []
    private(set) var files: [FileDoc] = []
    private(set) var work: [WorkItem] = []
    var canWrite: Bool { capabilitiesLoaded && hasFreshProject && !showsOffline && !isRestarting && connectionStatus == .connected && !isRevalidating && !isDemo && !isArchive && state?.project.archived != true
        && selectedProjectID.map { projectResults[$0] != .checking } != false }
    /// A cached snapshot is for reading only. Realtime hosts need an atomic sync for this selection.
    /// Operations-only hosts validate revisions per write; an optional sync failure cannot lock all writes.
    private var hasFreshProject: Bool {
        selectedProjectID == nil || (validatedProjectGeneration == projectGeneration && state?.project.id == selectedProjectID
            && (!realtimeSupported || !syncSupported || validatedWriteGeneration == projectGeneration))
    }
    var currentProjectName: String {
        state?.project.name ?? projects.first { $0.id == selectedProjectID }?.name
            ?? archivedProjects.first { $0.id == selectedProjectID }?.name ?? "IAMCEO"
    }
    var writeBlockedReason: String? {
        if isDemo { return "샘플은 읽기 전용입니다" }
        if isArchive || state?.project.archived == true { return "보관한 프로젝트는 읽기 전용입니다" }
        if let connectionNotice { return connectionNotice }
        if showsOffline { return "서버와 연결이 끊겼습니다" }
        if connectionStatus != .connected { return "잠시 연결을 확인하는 중" }
        if !hasFreshProject || (selectedProjectID != nil && state == nil) { return "프로젝트를 불러오는 중입니다" }
        if isRevalidating || !capabilitiesLoaded || selectedProjectID.map({ projectResults[$0] == .checking }) == true {
            return "최신 상태를 다시 확인하는 중입니다"
        }
        if state?.project.connection.ok == false { return "프로젝트의 실행 연결을 확인해 주세요" }
        return nil
    }
    /// Consumers can check one recipient instead of treating all send actions as a global lock.
    func sendActionKey(projectID: String, targetMemberID: String?) -> String {
        let scope = ChatHistoryKey.normalizedScope(targetMemberID: targetMemberID, members: members)
        let target: String? = if case .member(let id) = scope { id } else { nil }
        return "send:" + DraftStore.key(project: projectID, target: target)
    }
    func isSending(projectID: String, targetMemberID: String?) -> Bool {
        pendingActions.contains(sendActionKey(projectID: projectID, targetMemberID: targetMemberID))
    }
    let histories = ChatHistoryCache()
    private(set) var pagingSupport: HistoryPagingSupport = .unknown
    private(set) var isArchive = false
    private(set) var archivedProjects: [Project] = []
    private(set) var archiveError: String?
    private(set) var isLoadingArchive = false
    private(set) var projectResults: [String: ProjectChangeStatus] = [:]
    private(set) var projectNotice: String?
    private(set) var contextChecking: Set<String> = []
    private(set) var serverID: String?
    private(set) var pushConnectionError: PushSettingsError?
    private(set) var notificationNotice: String?
    /// The notice strip's 닫기: clears the notice itself (not one screen's copy), so it is gone on every tab.
    func dismissNotices() { notificationNotice = nil; projectNotice = nil }
    private(set) var notificationMessages: [Message] = []
    private(set) var notificationMessageID: String?
    @ObservationIgnored private var notificationScope: MessageScope?
    let pushSettings: PushSettingsStore
    let pushNotifications: PushNotificationService?
    var knownServerEndpoints: [String: String] { journal.serverEndpoints ?? [:] }
    var pendingPushRevocations: [String] { pushNotifications?.pendingRevocations ?? [] }
    @ObservationIgnored private var archiveObserved = false
    @ObservationIgnored private var notificationFlight = false
    @ObservationIgnored private var pendingNotification: NotificationLink?
    @ObservationIgnored private var pendingNotificationOwner: (router: WeakRouter, revision: Int)?
    @ObservationIgnored private var notificationRefreshRevision = 0
    @ObservationIgnored private var pushLogoutTask: Task<Void, Never>?
    @ObservationIgnored private var routers: [WeakRouter] = []
    private(set) var deliveryPages: [String: DeliveryNoticePage] = [:]
    private(set) var deliveryErrors: [String: String] = [:]
    private(set) var deliveryResults: [String: DeliveryRecoveryResult] = [:]
    private(set) var deliveryChecking: Set<String> = []
    /// Connection-scoped delivery knowledge also covers IDs not yet in /state's recent window.
    private var messageDeliveryUpdates: [Data: Message] = [:]
    var history: ChatHistory? {
        guard let key = histories.activeKey, key.projectID == selectedProjectID, key.archived == isArchive else { return nil }
        return histories.history(for: key)
    }
    var historyMessages: [Message] {
        if notificationMessageID != nil, notificationScope == ChatHistoryKey.normalizedScope(targetMemberID: historyTarget, members: members) {
            return notificationMessages
        }
        if isDemo || (!isArchive && pagingSupport == .unsupported) {
            let scope = ChatHistoryKey.normalizedScope(targetMemberID: historyTarget, members: members)
            return messages.filter { row in
                if case .member(let id) = scope { return row.memberId == id || row.targetMemberId == id }
                return true
            }
        }
        return history?.items ?? []
    }
    var deliveryNotices: DeliveryNotices? {
        guard state?.deliveryNotices?.version == 2 else { return nil }
        return state?.deliveryNotices
    }
    /// Only server-confirmed owner requests are interventions. Checking/waiting counts overlap totals.
    var deliveryAttentionMembers: [MemberDeliverySummary] { deliveryNotices?.members.filter { $0.needsOwnerCount > 0 } ?? [] }
    var unassignedDeliveries: [UnassignedDeliveryItem] { deliveryNotices?.unassignedItems ?? [] }
    var unassignedDeliveryAttentionCount: Int { deliveryNotices?.unassigned.needsOwnerCount ?? 0 }
    func deliverySummary(memberID: String) -> MemberDeliverySummary? {
        deliveryNotices?.members.first { $0.memberId == memberID }
    }
    @ObservationIgnored private var historyTarget: String?
    @ObservationIgnored private var historyVisible = false
    // Unique live registrations, ordered so a disappearing screen falls back to the latest survivor.
    @ObservationIgnored private var historyOwners: [(id: UUID, key: ChatHistoryKey?, targetMemberID: String?)] = []
    @ObservationIgnored private var historyFlight: (key: ChatHistoryKey, id: UUID, revision: Int, task: Task<Void, Never>)?
    @ObservationIgnored private var historyRestoration: (key: ChatHistoryKey, id: UUID, task: Task<Void, Never>)?
    @ObservationIgnored private var historyInvalidationRevision = 0
    @ObservationIgnored private var deliveryFlights: [String: UUID] = [:]
    @ObservationIgnored private var deliveryRefreshPending: Set<String> = []
    @ObservationIgnored private var archiveLoad = UUID()
    /// The server stopped answering after a successful connect. The last snapshot stays on screen (read-only),
    /// fallback keeps retrying, and the next successful refresh returns to `.connected`.
    var connectionLost: Bool { showsOffline }
    private(set) var showsOffline = false
    private(set) var isRestarting = false
    private(set) var isCheckingConnection = false
    var connectionNotice: String? {
        if isRestarting { return "서버를 다시 시작하는 중" }
        if !showsOffline, isCheckingConnection { return "잠시 연결을 확인하는 중" }
        return nil
    }
    /// Why the last sync failed while `connectionLost` (system wording, e.g. no internet vs. server not answering).
    private(set) var connectionIssue: String?
    private(set) var realtimeStatus: RealtimeStatus = .paused
    private(set) var isRevalidating = false
    private(set) var lastHeartbeatAt: Date?
    private(set) var lastSyncAttemptAt: Date?
    private(set) var lastSuccessfulSyncAt: Date?
    private(set) var receivedCursor: SyncCursor?
    private(set) var appliedSnapshotCursor: SyncCursor?
    private(set) var dirtyRevision = 0
    private(set) var resyncRevision = 0
    private(set) var activityRevisions: [String: Int] = [:]
    private(set) var activities: [String: [Activity]] = [:]
    private(set) var activityErrors: [String: String] = [:]
    var syncDescription: String {
        if isDemo { return "Sample workspace · read-only" }
        switch realtimeStatus {
        case .paused: return "Updates paused in background"
        case .connecting: return "Connecting to live updates…"
        case .syncing: return "Synchronizing latest state…"
        case .live: return lowPowerMode ? "Live · power saving" : "Connected live"
        case .legacy: return "Connected · legacy change notifications"
        case .fallback: return "Live updates interrupted · checking periodically"
        case .blocked: return "Check server address and access settings"
        }
    }
    @ObservationIgnored private let injectedSession: URLSession?
    @ObservationIgnored private let persistCredentials: Bool
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var projectGeneration = UUID()
    @ObservationIgnored private var refreshGeneration = UUID()
    @ObservationIgnored private let realtime: RealtimeClient?
    @ObservationIgnored private let syncClock: any RealtimeClock
    @ObservationIgnored private let retryJitter: @Sendable (Double) -> Double
    @ObservationIgnored private let lowPowerMode: Bool
    @ObservationIgnored private var socketGeneration = UUID()
    @ObservationIgnored private var foregroundGeneration = UUID()
    @ObservationIgnored private var coordinatorGeneration = UUID()
    @ObservationIgnored private var socketTask: Task<Void, Never>?
    @ObservationIgnored private var socketTransition: Task<Void, Never>?
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var fallbackTask: Task<Void, Never>?
    @ObservationIgnored private var coordinatorTask: Task<Void, Never>?
    @ObservationIgnored private var refreshWaiters: [UUID: (revision: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
    @ObservationIgnored private var dirty: RefreshScope = []
    @ObservationIgnored private var nextSnapshotAt: Duration = .zero
    @ObservationIgnored private var syncSupported = false
    @ObservationIgnored private var realtimeSupported = false
    private var capabilitiesLoaded = false
    @ObservationIgnored private var socketHello = false
    @ObservationIgnored private var highestRelevantSeq = 0
    private(set) var socketFailures = 0
    private(set) var restFailures = 0
    @ObservationIgnored private var lastSocketFrame: Duration?
    @ObservationIgnored private var firstTransportFailure: Duration?
    @ObservationIgnored private var transportFailureReason = "transport"
    @ObservationIgnored private var retriedConsistencyFailure = false
    @ObservationIgnored private var offlineChangedAt: Duration?
    @ObservationIgnored private var offlineTask: Task<Void, Never>?
    @ObservationIgnored private var syncRetryTask: Task<Void, Never>?
    @ObservationIgnored private var restartTask: Task<Void, Never>?
    @ObservationIgnored private var restartDeadline: Duration?
    @ObservationIgnored private var restartWindowUsed = false
    @ObservationIgnored private var foregroundGraceUntil: Duration?
    @ObservationIgnored private var foregroundRetry = 0
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var pathWasSatisfied: Bool?
    @ObservationIgnored private var lifecycleObservers: [NSObjectProtocol] = []
    private static let connectionLogger = Logger(subsystem: "com.iamceo.native", category: "Connection")
    @ObservationIgnored private var openActivityMembers: Set<String> = []
    @ObservationIgnored private var activityTokens: [String: UUID] = [:]
    @ObservationIgnored private var initialTask: Task<Bootstrap, Error>?
    @ObservationIgnored private var pendingConnect = false
    @ObservationIgnored private var refreshTask: Task<RefreshSnapshot, Error>?
    @ObservationIgnored private var foreground = true
    let drafts: DraftStore
    let composerUploads = ComposerAttachmentUploads()
    let submissions: SubmissionStore?
    private(set) var writeRevisions: SyncRevisions?
    private(set) var settingsEdit: SettingsEdit?
    private(set) var settingsConflict: Settings?
    private(set) var todoWrites: [String: TodoWriteState] = [:]
    private(set) var operationResults: [String: OperationReceipt] = [:]
    private(set) var batchResults: [String: CardWriteStatus] = [:]
    private(set) var writeNamespace = "unassigned"
    @ObservationIgnored private let writeStorage: LocalStateStorage
    @ObservationIgnored private var journal = AppWriteJournal()
    @ObservationIgnored private var persistenceFailure: String?
    @ObservationIgnored private var reviewedSettings: Settings?
    @ObservationIgnored private var reviewedMembers: [String: Member] = [:]
    @ObservationIgnored private var reviewedTodos: [String: Todo] = [:]
    @ObservationIgnored private var recoveryInFlight = false
    @ObservationIgnored private var writeContextGeneration = UUID()
    @ObservationIgnored private var leaseReceiptOrder: [String: Int] = [:]
    @ObservationIgnored private var absentOperations: Set<String> = []
    @ObservationIgnored private var strictWriteContract = false
    @ObservationIgnored private var lastReadError: String?
    /// Endpoint and code of the live client, so a reconnect from the offline strip can keep the last snapshot.
    @ObservationIgnored private var connectedCredentials: (endpoint: String, code: String)?
    @ObservationIgnored private var transportFailures = 0
    @ObservationIgnored private var validatedProjectGeneration: UUID?
    @ObservationIgnored private var validatedWriteGeneration: UUID?
    @ObservationIgnored private var projectCache = ProjectStateCache()
    @ObservationIgnored private var selectionRequestID = UUID()
    @ObservationIgnored private var appliedSyncIdentity: AppliedSyncIdentity?
    @ObservationIgnored private let navigationDefaults: UserDefaults?
    @ObservationIgnored private var pendingDraftRecovery = false
    @ObservationIgnored private var catalogDiscoveryTask: Task<Void, Never>?

    init(demo: Bool = false, session: URLSession? = nil, persistCredentials: Bool = true,
         drafts: DraftStore? = nil, submissions: SubmissionStore? = nil, writeStorageURL: URL? = nil,
         realtime: RealtimeClient? = nil, clock: any RealtimeClock = SystemRealtimeClock(),
         retryJitter: @escaping @Sendable (Double) -> Double = { $0 * Double.random(in: 0.8...1.2) },
         lowPowerMode: Bool = ProcessInfo.processInfo.isLowPowerModeEnabled,
         pushNotifications: PushNotificationService? = nil, navigationDefaults: UserDefaults? = nil,
         restoreCredentials: Bool = true) {
        self.navigationDefaults = demo ? nil : (navigationDefaults ?? (persistCredentials ? .standard : nil))
        injectedSession = session
        // URLProtocol cannot intercept a WebSocket upgrade. Injected HTTP sessions must also
        // inject a socket transport to opt in; tests can never escape to the real network.
        self.realtime = demo ? nil : (realtime ?? (session == nil ? RealtimeClient() : nil))
        syncClock = clock; self.retryJitter = retryJitter; self.lowPowerMode = lowPowerMode
        self.persistCredentials = persistCredentials && !demo
        isDemo = demo
        #if os(iOS)
        self.pushNotifications = demo ? nil : (pushNotifications ?? (persistCredentials ? PushNotificationService(
            provider: SystemPushAuthorizationProvider.shared,
            environment: PushNotificationService.environment(infoValue: Bundle.main.object(forInfoDictionaryKey: "IAMCEOPushEnvironment") as? String),
            persistOnInitialization: restoreCredentials) : nil))
        #else
        self.pushNotifications = demo ? nil : pushNotifications
        #endif
        pushSettings = self.pushNotifications?.settingsStore ?? PushSettingsStore()
        let composerDrafts = drafts ?? DraftStore(persist: persistCredentials && !demo, persistMigration: restoreCredentials)
        self.drafts = composerDrafts
        writeStorage = LocalStateStorage(enabled: !demo && (persistCredentials || writeStorageURL != nil),
                                         url: writeStorageURL, defaults: .standard, key: "iamceo.appWrites.v1")
        do {
            let restored = try writeStorage.read(AppWriteJournal.self) ?? AppWriteJournal()
            let restoredSubmissions = try submissions ?? SubmissionStore(persist: persistCredentials && !demo)
            if restoreCredentials { try restoredSubmissions.recoverMessageDrafts(drafts: composerDrafts) }
            else { pendingDraftRecovery = !demo }
            self.submissions = restoredSubmissions
            journal = restored
        } catch {
            self.submissions = nil
            persistenceFailure = error.localizedDescription
        }
        // iPhone's 127.0.0.1 is the phone itself: start empty there so the Tailscale HTTPS placeholder shows.
        #if os(macOS)
        let defaultEndpoint = "http://127.0.0.1:7878"
        #else
        let defaultEndpoint = ""
        #endif
        let savedEndpoint = self.persistCredentials && restoreCredentials ? (UserDefaults.standard.string(forKey: "iamceo.endpoint") ?? defaultEndpoint) : defaultEndpoint
        endpoint = savedEndpoint
        accessCode = self.persistCredentials && restoreCredentials ? (KeychainStore.accessCode(for: savedEndpoint) ?? "") : ""
        restoredCredentials = ConnectionRecovery.showsSavedConnection(endpoint: endpoint, accessCode: accessCode, useQR: false)
        if demo {
            modelCatalog = .demo
            let fixture = DemoFixtures.workspace()
            bootstrap = fixture.0
            state = fixture.1
            selectedProjectID = fixture.1.project.id
            connectionStatus = .demo
        }
        updateStateCollections()
        // Injected test sessions never subscribe to the machine's network or application lifecycle.
        if session == nil, !demo {
            let monitor = NWPathMonitor()
            pathMonitor = monitor
            monitor.pathUpdateHandler = { [weak self] path in
                let satisfied = path.status == .satisfied
                Task { @MainActor [weak self] in self?.networkPathChanged(satisfied: satisfied) }
            }
            monitor.start(queue: DispatchQueue(label: "com.iamceo.connection-path"))
            #if os(iOS)
            lifecycleObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.setForeground(false) }
            })
            #endif
        }
    }

    /// Collection consumers observe only their own slice, even when another slice changes.
    private func updateStateCollections() {
        if messages != (state?.messages ?? []) { messages = state?.messages ?? [] }
        if members != (state?.members ?? []) { members = state?.members ?? [] }
        if decisions != (state?.decisions ?? []) { decisions = state?.decisions ?? [] }
        if todos != (state?.todos ?? []) { todos = state?.todos ?? [] }
        if files != (state?.files ?? []) { files = state?.files ?? [] }
        if work != (state?.work ?? []) { work = state?.work ?? [] }
    }

    func connect() async {
        guard !isDemo else { return }
        // Returning from a sample must not write saved state until the owner actually connects.
        if pendingDraftRecovery {
            do {
                try submissions?.recoverMessageDrafts(drafts: drafts)
                pendingDraftRecovery = false
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        }
        // Canonical origins make a trailing slash or default port the same server.
        if let creds = connectedCredentials,
           let requested = try? ServerEndpoint(endpoint), let connected = try? ServerEndpoint(creds.endpoint),
           DraftStore.endpointNamespace(requested) == DraftStore.endpointNamespace(connected),
           creds.code == accessCode.trimmingCharacters(in: .whitespacesAndNewlines) {
            await restartRealtime()
            return
        }
        await establishConnection()
    }

    private func establishConnection() async {
        let sameServer = connectedCredentials.flatMap { try? ServerEndpoint($0.endpoint) }.map { previous in
            (try? ServerEndpoint(endpoint)).map { DraftStore.endpointNamespace($0) == DraftStore.endpointNamespace(previous) } ?? false
        } ?? false
        guard foreground else {
            // A requested host change invalidates writes/uploads now, even though networking
            // waits for the next active phase. A → B → A must reject A's late callbacks too.
            pendingConnect = true; stopRequests()
            generation = UUID(); projectGeneration = UUID()
            if !sameServer { clearHostNavigation(); projectCache.removeAll() }
            pushNotifications?.setHost(nil); pushSettings.setHost(nil)
            api = nil; connectionStatus = .disconnected; isLoading = false; isRevalidating = true
            drafts.selectNamespace("unassigned"); writeNamespace = "unassigned"
            return
        }
        resetConnectionEvidence()
        pendingConnect = false
        let previousProject = selectedProjectID
        let previousArchive = isArchive
        let previousState = state
        let previousOutage = apiOutage
        let previousBootstrap = bootstrap
        releaseAllTerminals()
        stopRequests()
        projectCache.removeAll()
        validatedProjectGeneration = nil; validatedWriteGeneration = nil
        generation = UUID()
        let connectionEpoch = generation
        if !sameServer { clearHostNavigation() }
        modelCatalog = .fallback
        api = nil; connectionStatus = .connecting
        if pushLogoutTask == nil { pushNotifications?.setHost(nil); pushSettings.setHost(nil) }
        await pushLogoutTask?.value
        guard connectionEpoch == generation else { return }
        pushLogoutTask = nil
        pushNotifications?.setHost(nil); pushSettings.setHost(nil)
        drafts.selectNamespace("unassigned")
        writeRevisions = nil; reviewedSettings = nil; reviewedMembers = [:]; reviewedTodos = [:]
        settingsEdit = nil; settingsConflict = nil; todoWrites = [:]; operationResults = [:]; batchResults = [:]
        leaseReceiptOrder = [:]; absentOperations = []; writeContextGeneration = UUID()
        strictWriteContract = false; syncSupported = false; realtimeSupported = false; capabilitiesLoaded = false
        receivedCursor = nil; appliedSnapshotCursor = nil; highestRelevantSeq = 0
        socketFailures = 0; restFailures = 0; nextSnapshotAt = .zero
        resetReadCollections()
        let epoch = generation
        lastReadError = nil
        connectionStatus = .connecting
        api = nil
        connectedCredentials = nil; transportFailures = 0; connectionIssue = nil
        pendingActions.removeAll()
        errorMessage = nil
        if sameServer {
            apiOutage = previousOutage
            bootstrap = previousBootstrap; state = previousState; selectedProjectID = previousProject; isArchive = previousArchive
        } else { apiOutage = nil; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil }
        isLoading = true
        defer { if epoch == generation { isLoading = false } }
        do {
            let validated = try ServerEndpoint(endpoint)
            guard !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(status: 0, message: "접속 코드를 넣어 주세요.") }
            let client = APIClient(endpoint: validated, accessCode: accessCode.trimmingCharacters(in: .whitespacesAndNewlines), session: injectedSession, liteStateEnabled: true)
            let task = Task { try await client.request("/api/bootstrap") as Bootstrap }
            initialTask = task
            let initial = try await task.value
            guard epoch == generation, foreground, !Task.isCancelled else { return }
            initialTask = nil
            api = client
            writeNamespace = DraftStore.endpointNamespace(validated)
            drafts.selectNamespace(writeNamespace)
            bootstrap = initial
            apiOutage = initial.apiOutage
            runtime = initial.runtime
            endpoint = validated.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if persistCredentials { UserDefaults.standard.set(endpoint, forKey: "iamceo.endpoint") }
            do { if persistCredentials { try KeychainStore.save(accessCode, for: endpoint) } }
            catch { errorMessage = error.localizedDescription }
            connectedCredentials = (endpoint, accessCode.trimmingCharacters(in: .whitespacesAndNewlines))
            connectionStatus = .connected
            // Reading the workspace never waits for the model catalog or capability probe.
            catalogDiscoveryTask = Task { [weak self] in await self?.refreshModels() }
            async let discovery: Void = discoverCapabilities()
            if !sameServer { restoreNavigation() }
            let saved = sameServer ? (previousProject ?? savedProjectID()) : savedProjectID()
            if sameServer, previousArchive, let saved {
                await selectArchivedProject(id: saved)
            } else if let project = initial.projects.first(where: { $0.id == saved })
                ?? initial.projects.first(where: { $0.isHq || $0.id == "hq" }) ?? initial.projects.first {
                await selectProject(id: project.id)
            }
            await discovery
            guard epoch == generation, foreground else { return }
            // A state read that preceded discovery cannot supply the strict write revisions.
            if syncSupported, validatedWriteGeneration != projectGeneration {
                nextSnapshotAt = .zero
                await refresh()
            }
            else if selectedProjectID == nil { await refreshWriteContext() }
            guard epoch == generation, foreground else { return }
            if runtime == nil { await refreshDiagnostics() }
            await recoverWrites()
            guard epoch == generation, api != nil else { return }
            await refreshPushConnection()
            guard epoch == generation, api != nil else { return }
            if foreground { startSocket(); startFallback() }
        } catch {
            guard epoch == generation, foreground else { return }
            api = nil
            connectionStatus = .failed
            errorMessage = error.localizedDescription
        }
    }

    /// Restart transport and revalidate without changing project, drafts, windows, or route.
    func restartRealtime() async {
        guard !isDemo else { return }
        guard api != nil, bootstrap != nil else { await establishConnection(); return }
        socketFailures = 0; restFailures = 0; transportFailures = 0; nextSnapshotAt = .zero
        isRevalidating = true
        guard foreground else { return }
        invalidateCoordinator()
        reconnectTask?.cancel(); reconnectTask = nil
        fallbackTask?.cancel(); fallbackTask = nil
        stopSocket()
        startSocket(); startFallback()
        async let discovery: Void = discoverCapabilities()
        await discovery
        await refresh()
    }

    private var navigationKey: String { "iamceo.navigation.v1." + writeNamespace }
    private func savedProjectID() -> String? {
        navigationDefaults?.dictionary(forKey: navigationKey)?["projectID"] as? String
    }
    private func saveNavigation(destination: Destination? = nil) {
        guard !isDemo, writeNamespace != "unassigned" else { return }
        var saved = navigationDefaults?.dictionary(forKey: navigationKey) ?? [:]
        if let selectedProjectID { saved["projectID"] = selectedProjectID }
        if let destination { saved["destination"] = destination.rawValue }
        navigationDefaults?.set(saved, forKey: navigationKey)
    }
    private func restoreNavigation() {
        let saved = navigationDefaults?.dictionary(forKey: navigationKey)?["destination"] as? String
        let destination = saved.flatMap(Destination.init(rawValue:)) ?? .home
        for item in routers { item.value?.restoreDestination(destination) }
    }

    /// Stop a discarded workspace without logging out, deleting credentials or saving navigation.
    func prepareForReplacement() {
        foreground = false
        pendingConnect = false
        foregroundGeneration = UUID()
        generation = UUID()
        projectGeneration = UUID()
        stopRequests()
        pushNotifications?.setHost(nil)
        pushSettings.setHost(nil)
        pathMonitor?.cancel()
        pathMonitor = nil
        lifecycleObservers.forEach(NotificationCenter.default.removeObserver)
        lifecycleObservers.removeAll()
        api = nil
    }

    func disconnect() {
        resetConnectionEvidence()
        beginPushLogout()
        clearHostNavigation()
        NotificationInbox.shared.discardPending()
        releaseAllTerminals()
        stopRequests()
        resetReadCollections()
        projectCache.removeAll(); validatedProjectGeneration = nil; validatedWriteGeneration = nil
        generation = UUID(); projectGeneration = UUID()
        if persistCredentials { KeychainStore.remove(for: endpoint) }
        realtimeStatus = .paused; isRevalidating = false
        receivedCursor = nil; appliedSnapshotCursor = nil
        modelCatalog = .fallback
        api = nil; accessCode = ""; apiOutage = nil; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
        restoredCredentials = false
        connectedCredentials = nil; transportFailures = 0; connectionIssue = nil
        pendingConnect = false
        connectionStatus = .disconnected
        drafts.selectNamespace("unassigned"); writeNamespace = "unassigned"
        writeRevisions = nil; settingsEdit = nil; settingsConflict = nil
        todoWrites = [:]; operationResults = [:]; batchResults = [:]
        pendingActions.removeAll(); terminalLeases.removeAll(); terminalWindowNotices.removeAll(); isLoading = false; errorMessage = nil; lastUpdated = nil
    }

    func logout() async {
        disconnect()
        await pushLogoutTask?.value
    }

    func selectProject(id: String) async { await selectProject(id: id, archived: false) }
    func selectArchivedProject(id: String) async { await selectProject(id: id, archived: true) }

    private func selectProject(id: String, archived: Bool, navigationToken: UUID? = nil) async {
        if isDemo { return }
        guard api != nil, connectionStatus == .connected else { return }
        let selectionRequestID = UUID()
        self.selectionRequestID = selectionRequestID
        if selectedProjectID == id, isArchive == archived, navigationToken == nil {
            await refresh()
            return
        }
        // Cache only when leaving a project. JSON encoding never inherits MainActor.
        if let state {
            let epoch = generation
            let encoded = await ProjectStateCache.encode(state)
            guard epoch == generation, selectionRequestID == self.selectionRequestID else { return }
            projectCache.insert(state, encoded: encoded)
        }
        refreshTask?.cancel()
        projectGeneration = navigationToken ?? UUID()
        if navigationToken == nil { for item in routers { item.value?.cancelPendingNavigation() } }
        leaveNotificationAnchor()
        let projectEpoch = projectGeneration
        let epoch = generation
        cancelHistoryLoad()
        historyVisible = false; historyOwners = []; historyTarget = nil
        deliveryPages = [:]; deliveryErrors = [:]; deliveryResults = [:]; deliveryFlights = [:]; deliveryChecking = []; deliveryRefreshPending = []
        isArchive = archived
        selectedProjectID = id
        state = mergingRecentMessageDelivery(projectCache.value(projectID: id, archived: archived))
        saveNavigation()
        writeRevisions?.members = nil; writeRevisions?.todos = nil
        reviewedMembers = [:]; reviewedTodos = [:]
        errorMessage = nil
        isLoading = true
        defer { if projectEpoch == projectGeneration { isLoading = false } }
        // Selection invalidates only project reads. The host socket continues receiving cursors.
        invalidateCoordinator()
        nextSnapshotAt = .zero
        openActivityMembers.removeAll(); activities = [:]; activityErrors = [:]
        await enqueueRefresh(.all, immediate: true, allowPaused: true)
        guard epoch == generation, projectEpoch == projectGeneration else { return }
    }

    /// Manual refreshes and all post-write invalidations share the event single flight.
    func refresh() async {
        guard !isDemo, api != nil, connectionStatus == .connected || connectionLost else { return }
        if realtimeStatus == .blocked, foreground {
            restFailures = 0; startSocket(); startFallback()
        }
        await enqueueRefresh(.all, immediate: true, allowPaused: true)
    }

    func refreshDiagnostics() async { await enqueueRefresh(.diagnostics, immediate: true) }

    func refreshModels() async {
        guard !isDemo, let api else { return }
        let epoch = generation
        if let modelsTask {
            let requestID = modelsRequestID
            if let catalog = try? await modelsTask.value,
               epoch == generation, requestID == modelsRequestID, !modelsTask.isCancelled { modelCatalog = catalog }
            return
        }
        let requestID = UUID()
        modelsRequestID = requestID
        let task = Task { try await api.models() }
        modelsTask = task
        defer { if modelsRequestID == requestID { modelsTask = nil } }
        do {
            let catalog = try await task.value
            guard epoch == generation, modelsRequestID == requestID, !task.isCancelled else { return }
            modelCatalog = catalog
        } catch { /* Keep the last list (or defaults) during a transient failure. */ }
    }

    func setForeground(_ active: Bool) {
        #if os(iOS)
        // SwiftUI sends false for .inactive (Control Center, permission dialogs). Only background pauses.
        if !active, injectedSession == nil, UIApplication.shared.applicationState != .background { return }
        #endif
        guard foreground != active else { return }
        foreground = active; foregroundGeneration = UUID()
        if active {
            if pendingConnect {
                Task { [weak self] in await self?.connect() }
                return
            }
            guard api != nil, connectionStatus == .connected || connectionLost else { return }
            isRevalidating = true; isCheckingConnection = true
            socketFailures = 0; restFailures = 0; transportFailures = 0; firstTransportFailure = nil
            foregroundRetry = 0; nextSnapshotAt = .zero
            startSocket(); startFallback()
            var scope: RefreshScope = runtime == nil ? [.all, .diagnostics] : .all
            if archiveObserved { scope.insert(.archive) }
            Task { [weak self] in
                guard let self else { return }
                let epoch = generation, phase = foregroundGeneration
                foregroundGraceUntil = await syncClock.now() + .seconds(5)
                guard epoch == generation, phase == foregroundGeneration, foreground else { return }
                // An initial probe invalidated by backgrounding must get another chance.
                async let discovery: Void = discoverCapabilities()
                await enqueueRefresh(scope, immediate: true)
                await discovery
                guard epoch == generation, phase == foregroundGeneration, foreground else { return }
                if syncSupported, validatedWriteGeneration != projectGeneration { await refresh() }
                await refreshPushConnection()
            }
        } else {
            if connectionStatus == .connecting, api == nil { pendingConnect = true }
            // Invalidates permission/token continuations before they can upload in the background.
            if pushLogoutTask == nil { pushNotifications?.setHost(nil); pushSettings.setHost(nil) }
            stopRequests()
            realtimeStatus = .paused
        }
    }

    private func invalidateCoordinator() {
        coordinatorGeneration = UUID(); refreshGeneration = UUID()
        coordinatorTask?.cancel(); coordinatorTask = nil
        refreshTask?.cancel(); refreshTask = nil
        initialTask?.cancel(); initialTask = nil
        dirty = []
        finishRefreshWaiters()
    }

    private func finishRefreshWaiters(through revision: Int? = nil) {
        for (id, waiter) in refreshWaiters where revision.map({ waiter.revision <= $0 }) ?? true {
            refreshWaiters.removeValue(forKey: id)?.continuation.resume()
        }
    }

    private func enqueueRefresh(_ scope: RefreshScope, immediate: Bool = false, allowPaused: Bool = false) async {
        guard !isDemo, api != nil, foreground || allowPaused else { return }
        dirty.formUnion(scope); dirtyRevision &+= 1
        if scope.contains(.history) { historyInvalidationRevision &+= 1 }
        let requestedRevision = dirtyRevision
        let waiterID = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(); return }
                // Register before starting the task, including when every read completes immediately.
                refreshWaiters[waiterID] = (requestedRevision, continuation)
                if coordinatorTask == nil {
                    let token = coordinatorGeneration, epoch = generation, phase = foregroundGeneration
                    let task = Task { [weak self] in
                        guard let self else { return }
                        defer {
                            if token == coordinatorGeneration {
                                coordinatorTask = nil
                                finishRefreshWaiters()
                            }
                        }
                        do {
                            let now = await syncClock.now()
                            let delay = max(scope.contains(.snapshot) ? nextSnapshotAt - now : .zero, immediate ? .zero : (lowPowerMode ? .milliseconds(500) : .milliseconds(250)))
                            if delay > .zero { try await syncClock.sleep(for: delay) }
                            while !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration, !dirty.isEmpty {
                                let scopes = dirty, passRevision = dirtyRevision
                                dirty = []
                                let now = await syncClock.now()
                                if scopes.contains(.snapshot) {
                                    let delay = nextSnapshotAt - now
                                    if delay > .zero { try await syncClock.sleep(for: delay) }
                                    guard !Task.isCancelled, token == coordinatorGeneration else { return }
                                    nextSnapshotAt = await syncClock.now() + (lowPowerMode ? .seconds(1) : .milliseconds(500))
                                    await readSnapshot()
                                }
                                guard !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration else { return }
                                if scopes.contains(.history), historyVisible { await refreshHistory() }
                                if scopes.contains(.delivery), foreground {
                                    for memberID in Set(deliveryPages.keys).union(deliveryFlights.keys) {
                                        if memberID.isEmpty { await loadUnassignedDeliveries() }
                                        else { await loadDeliveryNotices(memberID: memberID) }
                                        guard !Task.isCancelled, token == coordinatorGeneration else { return }
                                    }
                                }
                                if scopes.contains(.activity) { await readActivities() }
                                if scopes.contains(.diagnostics) { await readDiagnostics() }
                                if scopes.contains(.archive) { await loadArchivedProjects() }
                                guard !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration else { return }
                                // Release only requests included in this pass; later events keep draining independently.
                                finishRefreshWaiters(through: passRevision)
                            }
                        } catch { /* Lifecycle cancellation owns invalidation. */ }
                    }
                    coordinatorTask = task
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.refreshWaiters.removeValue(forKey: waiterID)?.continuation.resume()
            }
        }
    }

    private func discoverCapabilities() async {
        guard !capabilitiesLoaded, let api else { return }
        let epoch = generation, phase = foregroundGeneration
        do {
            let capabilities = try await api.capabilities()
            guard epoch == generation, phase == foregroundGeneration else { return }
            capabilitiesLoaded = true
            strictWriteContract = capabilities.contractVersion == 2 && capabilities.capabilities?.operations == true
            realtimeSupported = capabilities.contractVersion == 2 && capabilities.capabilities?.realtime == true
            syncSupported = capabilities.contractVersion == 2 && (capabilities.capabilities?.realtime == true || strictWriteContract)
        } catch {
            guard epoch == generation, phase == foregroundGeneration else { return }
            if (error as? APIError)?.status == 401 { handle(error); return }
            guard !Task.isCancelled else { return }
            // Discovery is optional (spec 3.3). A completed failed probe opens the
            // unadvertised v1 path; it never clears a previously confirmed v2 contract.
            capabilitiesLoaded = true
        }
    }

    private func readSnapshot() async {
        guard let api else { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration
        let socketEpoch = socketGeneration, requestID = UUID()
        refreshGeneration = requestID
        let projectID = selectedProjectID, archived = isArchive
        let supportsSync = syncSupported, optionalWriteContext = !realtimeSupported
        let explicitSelection = isLoading
        lastSyncAttemptAt = Date()
        let task = Task { () throws -> RefreshSnapshot in
            func readArchive(_ id: String) async throws -> ProjectState? {
                do { return try await api.archiveState(projectID: id) }
                catch let error as APIError where error.status == 404 {
                    try Task.checkCancellation()
                    let archived = try await api.archivedProjects()
                    // A missing reader on an older host is not proof the project was restored.
                    guard !archived.contains(where: { $0.id == id }) else { throw error }
                    return nil
                }
            }
            if supportsSync, !optionalWriteContext {
                do {
                    let snapshot = try await api.sync(projectID: archived ? nil : projectID)
                    if archived, let projectID {
                        return RefreshSnapshot(bootstrap: snapshot.bootstrap, state: try await readArchive(projectID), sync: snapshot)
                    }
                    return RefreshSnapshot(bootstrap: snapshot.bootstrap, state: snapshot.state, sync: snapshot)
                } catch {
                    if (error as? APIError)?.status == 401 { throw error }
                    // Operations-only capability is the older optional write-context probe.
                    // A realtime server may fall back only on an actual missing sync route.
                    guard optionalWriteContext || (error as? APIError)?.status == 404 else { throw error }
                }
            }
            var next: Bootstrap = try await api.request("/api/bootstrap")
            let state: ProjectState?
            if let projectID, archived {
                state = try await readArchive(projectID)
                if state == nil { next = try await api.request("/api/bootstrap") }
            }
            else if let projectID, explicitSelection || next.projects.contains(where: { $0.id == projectID }) {
                do { state = try await api.request("/api/projects/\(APIClient.segment(projectID))/state") }
                catch let error as APIError where error.status == 404 {
                    // The project can be archived between bootstrap and state. Confirm membership again.
                    next = try await api.request("/api/bootstrap")
                    guard !next.projects.contains(where: { $0.id == projectID }) else { throw error }
                    state = nil
                }
            } else { state = nil }
            var context: SyncSnapshot?
            if supportsSync, optionalWriteContext {
                do { context = try await api.sync(projectID: archived ? nil : projectID) }
                catch { if (error as? APIError)?.status == 401 { throw error } }
            }
            return RefreshSnapshot(bootstrap: next, state: state, sync: context)
        }
        refreshTask = task
        defer { if requestID == refreshGeneration { refreshTask = nil } }
        do {
            let result = try await task.value
            let completedAt = await syncClock.now()
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                  socketEpoch == socketGeneration, requestID == refreshGeneration else { return }
            if let next = result.state {
                guard next.project.id == projectID, next.project.archived == archived else { throw SubmissionError.mismatchedResult }
            }
            var applyDomain = true
            if let snapshot = result.sync {
                guard snapshot.requestedProjectId == (archived ? nil : projectID), snapshot.projectStatus != .unknown else { throw SubmissionError.mismatchedResult }
                if socketHello, let receivedCursor, snapshot.cursor.epoch != receivedCursor.epoch {
                    throw RealtimeClientError.invalidFrame
                }
                if let applied = appliedSnapshotCursor, applied.epoch == snapshot.cursor.epoch, applied.seq > snapshot.cursor.seq {
                    throw RealtimeClientError.invalidFrame
                }
                // Cursors are host-wide: a different selection at the same cursor still needs its state.
                // Archive/legacy reads are independent of /sync and must always compare their payloads.
                applyDomain = archived || optionalWriteContext || appliedSyncIdentity != AppliedSyncIdentity(
                    selection: projectEpoch, cursor: snapshot.cursor, revisions: snapshot.revisions, projectStatus: snapshot.projectStatus)
                let changedEpoch = appliedSnapshotCursor != nil && appliedSnapshotCursor?.epoch != snapshot.cursor.epoch
                if appliedSnapshotCursor != snapshot.cursor { appliedSnapshotCursor = snapshot.cursor }
                if receivedCursor?.epoch == snapshot.cursor.epoch {
                    let cursor = try SyncCursor(epoch: snapshot.cursor.epoch, seq: max(receivedCursor?.seq ?? 0, snapshot.cursor.seq))
                    if receivedCursor != cursor { receivedCursor = cursor }
                }
                if socketHello, highestRelevantSeq > snapshot.cursor.seq { dirty.formUnion(.snapshot) }
                try applyWriteContext(snapshot)
                if changedEpoch { dirty.formUnion([.diagnostics, .history, .activity, .delivery]) }
            } else if supportsSync, !optionalWriteContext { syncSupported = false }
            // Probe timestamps can change even when the domain cursor stays the same.
            apiOutage = result.sync.map { $0.apiOutage } ?? result.bootstrap.apiOutage
            if applyDomain {
                if bootstrap != result.bootstrap { bootstrap = result.bootstrap }
                if let diagnostics = result.bootstrap.runtime, runtime != diagnostics { runtime = diagnostics }
                let next = mergingRecentMessageDelivery(result.state)
                if state != next { state = next }
            }
            if let snapshot = result.sync {
                appliedSyncIdentity = AppliedSyncIdentity(selection: projectEpoch, cursor: snapshot.cursor,
                    revisions: snapshot.revisions, projectStatus: snapshot.projectStatus)
            }
            validatedProjectGeneration = projectEpoch
            if result.sync != nil { validatedWriteGeneration = projectEpoch }
            if state == nil, let projectID { projectCache.remove(projectID: projectID) }
            reconcileContextChanges()
            markReachable(at: completedAt); restFailures = 0; isRevalidating = false
            syncRetryTask?.cancel(); syncRetryTask = nil
            if socketHello { socketFailures = 0 }
            lastUpdated = Date(); lastSuccessfulSyncAt = lastUpdated
            clearReadError()
            resyncRevision &+= 1
            if foreground, socketHello, !dirty.contains(.snapshot) {
                realtimeStatus = receivedCursor == nil ? .legacy : .live
                fallbackTask?.cancel(); fallbackTask = nil
            }
            if projectID != nil, result.state == nil {
                // /sync explicitly distinguishes a missing/archived selection from a missing route.
                selectedProjectID = nil
                projectNotice = "보던 프로젝트를 사용할 수 없어 본사로 돌아갑니다."
                if let first = result.bootstrap.projects.first(where: { $0.id == "hq" }) ?? result.bootstrap.projects.first {
                    Task { [weak self] in await self?.selectProject(id: first.id) }
                } else { projectGeneration = UUID() }
            }
            await reconcileProjectChanges()
            await recoverWrites()
        } catch {
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                  socketEpoch == socketGeneration, requestID == refreshGeneration else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if (error as? APIError)?.status == 401 { handle(error); return }
            if let apiError = error as? APIError, apiError.status == 503, apiError.code == "STARTING", !restartWindowUsed || isRestarting {
                await beginRestart()
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                      socketEpoch == socketGeneration, requestID == refreshGeneration else { return }
                scheduleSyncRetry(after: .milliseconds(500))
                return
            }
            if isRestarting {
                scheduleSyncRetry(after: .milliseconds(500))
                return
            }
            restFailures += 1
            if Self.isUnreachable(error) {
                await markUnreachable(error)
            } else {
                // A response or a local consistency failure is a sync problem, never loss evidence.
                transportFailures = 0; firstTransportFailure = nil
                offlineTask?.cancel(); offlineTask = nil
                isRevalidating = true; isCheckingConnection = true
                connectionIssue = "동기화 다시 시도 중"
                clearReadError()
            }
            let now = await syncClock.now()
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                  socketEpoch == socketGeneration, requestID == refreshGeneration else { return }
            let delay: Duration
            if Self.isUnreachable(error), let until = foregroundGraceUntil, now < until {
                delay = [.milliseconds(300), .seconds(1), .seconds(2)][min(foregroundRetry, 2)]
                foregroundRetry += 1
            } else if !retriedConsistencyFailure, error as? RealtimeClientError == .invalidFrame || Self.isConsistencyFailure(error) {
                retriedConsistencyFailure = true
                delay = .milliseconds(500)
            } else {
                delay = .seconds(min(retryCap, max(1, pow(2, Double(min(restFailures - 1, 5))))))
            }
            scheduleSyncRetry(after: delay)
        }
    }

    private func startSocket() {
        guard foreground, let api, let realtime, socketTask == nil else { return }
        reconnectTask?.cancel(); reconnectTask = nil
        socketGeneration = UUID(); let socketID = socketGeneration
        let epoch = generation, phase = foregroundGeneration
        socketHello = false; lastSocketFrame = nil
        realtimeStatus = .connecting
        let transition = socketTransition
        socketTask = Task { [weak self] in
            await transition?.value
            guard let self, !Task.isCancelled, socketID == socketGeneration, epoch == generation, phase == foregroundGeneration else { return }
            do {
                let stream = try await realtime.connect(api: api)
                for try await event in stream {
                    guard !Task.isCancelled, socketID == socketGeneration, epoch == generation, phase == foregroundGeneration else { return }
                    await receive(event)
                }
            } catch {
                // Socket status never authenticates a user; REST does that.
                guard !Task.isCancelled, socketID == socketGeneration, epoch == generation, phase == foregroundGeneration else { return }
                if error as? RealtimeClientError == .restarting { await beginRestart() }
            }
            guard !Task.isCancelled, socketID == socketGeneration, epoch == generation, phase == foregroundGeneration else { return }
            socketFailed()
            nextSnapshotAt = .zero
            Task { [weak self] in await self?.enqueueRefresh(.all, immediate: true) }
        }
    }

    private func stopSocket() {
        socketGeneration = UUID(); socketHello = false; lastSocketFrame = nil
        socketTask?.cancel(); socketTask = nil
        guard let realtime else { return }
        let previous = socketTransition
        socketTransition = Task { await previous?.value; await realtime.disconnect() }
    }

    private func socketFailed() {
        stopSocket()
        guard foreground, api != nil else { return }
        realtimeStatus = .fallback
        startFallback()
        guard realtime != nil, reconnectTask == nil else { return }
        let delay = isRestarting ? 0.5 : min(retryCap, max(0, retryJitter(min(retryCap, 0.5 * pow(2, Double(min(socketFailures, 6)))))))
        if !isRestarting { socketFailures += 1 }
        let epoch = generation, phase = foregroundGeneration
        reconnectTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: .seconds(delay)) } catch { return }
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            reconnectTask = nil; startSocket()
        }
    }

    private func startFallback() {
        guard foreground, api != nil, fallbackTask == nil, realtimeStatus != .live, realtimeStatus != .legacy, realtimeStatus != .blocked else { return }
        if socketTask == nil { realtimeStatus = .fallback }
        let epoch = generation, phase = foregroundGeneration
        fallbackTask = Task { [weak self, syncClock] in
            while !Task.isCancelled {
                guard let self, epoch == generation, phase == foregroundGeneration, foreground else { return }
                let base = lowPowerMode ? 10.0 : 3.0
                let interval = isRestarting ? 0.5 : restFailures == 0 ? min(retryCap, base) : min(retryCap, max(0, retryJitter(min(retryCap, base * pow(2, Double(min(restFailures - 1, 4)))))))
                do { try await syncClock.sleep(for: .seconds(interval)) } catch { return }
                guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
                await enqueueRefresh(.all, immediate: true)
            }
        }
    }

    private func receive(_ event: RealtimeEvent) async {
        let epoch = generation, phase = foregroundGeneration, socketID = socketGeneration
        let now = await syncClock.now()
        guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, socketID == socketGeneration else { return }
        lastHeartbeatAt = Date()
        lastSocketFrame = now
        if event.type == "restarting" { await beginRestart(); socketFailed(); return }
        if event.type == "hello" {
            // Optional discovery can fail independently. A valid v2 hello is sufficient to
            // probe /sync; only that route's 404 permits bootstrap/state compatibility.
            if event.cursor != nil { syncSupported = true; realtimeSupported = true }
            receivedCursor = event.cursor; highestRelevantSeq = event.cursor?.seq ?? 0
            socketHello = true; realtimeStatus = .syncing
            // Join an in-flight snapshot. Its result is checked against this hello's cursor below.
            if refreshTask == nil {
                if showsOffline || restFailures > 0 || isRestarting { nextSnapshotAt = .zero }
                Task { [weak self] in await self?.enqueueRefresh(.all, immediate: true) }
            }
            return
        }
        if let cursor = event.cursor, let previous = receivedCursor {
            guard cursor.epoch == previous.epoch, event.type != "ping" || cursor.seq >= previous.seq else {
                socketFailed()
                Task { [weak self] in await self?.enqueueRefresh(.all, immediate: true) }
                return
            }
            if event.type == "ping" {
                if cursor.seq > previous.seq {
                    receivedCursor = cursor; highestRelevantSeq = max(highestRelevantSeq, cursor.seq)
                    realtimeStatus = .syncing
                    Task { [weak self] in await self?.enqueueRefresh(.all) }
                }
                return
            }
            guard cursor.seq > previous.seq else { return }
            receivedCursor = cursor
            if cursor.seq > previous.seq + 1 {
                highestRelevantSeq = max(highestRelevantSeq, cursor.seq); realtimeStatus = .syncing
                Task { [weak self] in await self?.enqueueRefresh(.all) }
                return
            }
        } else if event.type == "ping" { return }
        if event.type == "activity" {
            if event.projectId == selectedProjectID, let memberID = event.activity?.memberId, openActivityMembers.contains(memberID) {
                activityRevisions[memberID, default: 0] &+= 1
                Task { [weak self] in await self?.enqueueRefresh(.activity) }
            }
            return
        }
        let project = event.project?.id ?? event.member?.projectId ?? event.projectId ?? event.decision?.projectId ?? event.todo?.projectId ?? event.message?.projectId ?? event.file?.projectId
        if event.type == "project" || event.type == "projects" {
            if event.project?.id == selectedProjectID, event.project?.archived == true, !isArchive {
                state?.project.archived = true
            }
            if archiveObserved { Task { [weak self] in await self?.enqueueRefresh(.archive) } }
        }
        let global = ["projects", "settings", "herdr"].contains(event.type)
        let known = ["project", "member", "member_removed", "decision", "todo", "work", "message", "file"].contains(event.type)
        guard global || !known || project == selectedProjectID else { return }
        if let cursor = event.cursor { highestRelevantSeq = max(highestRelevantSeq, cursor.seq) }
        var scope: RefreshScope = !known && !global ? .all : .snapshot
        if event.type == "message" {
            if let message = event.message { receiveHistoryMessage(message) }
            scope.formUnion([.history, .delivery])
        } else if event.type == "member" || event.type == "member_removed" {
            scope.formUnion([.delivery, .history])
        } else if !known { scope.insert(.delivery) }
        Task { [weak self] in await self?.enqueueRefresh(scope) }
    }

    func activateActivity(memberID: String) async {
        guard members.contains(where: { $0.id == memberID }) else { return }
        openActivityMembers.insert(memberID); activityTokens[memberID] = UUID()
        await enqueueRefresh(.activity, immediate: true)
    }
    func deactivateActivity(memberID: String) { openActivityMembers.remove(memberID); activityTokens[memberID] = nil }

    private func readActivities() async {
        guard foreground, let api, connectionStatus == .connected else { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration
        for memberID in openActivityMembers {
            let activityToken = activityTokens[memberID]
            do {
                let items = try await api.activity(memberID: memberID)
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration else { return }
                guard openActivityMembers.contains(memberID), activityTokens[memberID] == activityToken else { continue }
                activities[memberID] = items.sorted { $0.id > $1.id }; activityErrors[memberID] = nil
            } catch {
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration else { return }
                if (error as? APIError)?.status == 401 { handle(error); return }
                if openActivityMembers.contains(memberID), activityTokens[memberID] == activityToken { activityErrors[memberID] = error.localizedDescription }
            }
        }
    }

    private func readDiagnostics() async {
        guard foreground, let api else { return }
        let epoch = generation, phase = foregroundGeneration, token = coordinatorGeneration
        do {
            let result: RuntimeDiagnostics = try await api.request("/api/runtime")
            guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, token == coordinatorGeneration else { return }
            runtime = result
        } catch {
            guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration else { return }
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    private var retryCap: Double {
        ["127.0.0.1", "localhost", "::1"].contains(api?.endpoint.url.host ?? "") ? 3 : 30
    }

    private static func isConsistencyFailure(_ error: Error) -> Bool {
        if case SubmissionError.mismatchedResult = error { return true }
        return false
    }

    private static func isUnreachable(_ error: Error) -> Bool {
        let transport: Set<URLError.Code> = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
            .dnsLookupFailed, .timedOut, .internationalRoamingOff, .dataNotAllowed, .callIsActive]
        return [502, 503, 504].contains((error as? APIError)?.status ?? 0)
            || (error as? URLError).map { transport.contains($0.code) } == true
    }

    private func socketIsHealthy(at now: Duration) -> Bool {
        socketHello && socketTask != nil && lastSocketFrame.map { now - $0 < .seconds(20) } == true
    }

    private func markUnreachable(_ error: Error) async {
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, api != nil, bootstrap != nil else { return }
        transportFailures += 1
        if firstTransportFailure == nil { firstTransportFailure = now }
        transportFailureReason = (error as? URLError).map { "transport_\($0.code.rawValue)" }
            ?? "gateway_\((error as? APIError)?.status ?? 0)"
        connectionIssue = error.localizedDescription
        clearReadError()
        if !socketIsHealthy(at: now) { isRevalidating = true; isCheckingConnection = true }
        await evaluateOffline()
    }

    private func evaluateOffline() async {
        offlineTask?.cancel(); offlineTask = nil
        guard foreground, !isRestarting, transportFailures >= 2, let firstTransportFailure else { return }
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard epoch == generation, phase == foregroundGeneration, foreground, !isRestarting,
              transportFailures >= 2, self.firstTransportFailure == firstTransportFailure else { return }
        var deadline = firstTransportFailure + .seconds(3)
        if let foregroundGraceUntil { deadline = max(deadline, foregroundGraceUntil) }
        if socketIsHealthy(at: now), let lastSocketFrame { deadline = max(deadline, lastSocketFrame + .seconds(20)) }
        if !showsOffline, let offlineChangedAt { deadline = max(deadline, offlineChangedAt + .seconds(2)) }
        if now >= deadline {
            setOffline(true, at: now, reason: transportFailureReason, duration: now - firstTransportFailure)
            connectionStatus = .disconnected; isRevalidating = true; isCheckingConnection = false
        } else {
            offlineTask = Task { [weak self, syncClock] in
                do { try await syncClock.sleep(for: deadline - now) } catch { return }
                guard !Task.isCancelled else { return }
                await self?.evaluateOffline()
            }
        }
    }

    private func setOffline(_ value: Bool, at now: Duration, reason: String, duration: Duration) {
        guard showsOffline != value else { return }
        showsOffline = value; offlineChangedAt = now
        let seconds = Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
        Self.connectionLogger.notice("showsOffline=\(value, privacy: .public) reason=\(reason, privacy: .public) duration_seconds=\(seconds, privacy: .public)")
    }

    private func markReachable(at now: Duration) {
        transportFailures = 0; firstTransportFailure = nil
        offlineTask?.cancel(); offlineTask = nil
        connectionIssue = nil; isCheckingConnection = false; retriedConsistencyFailure = false
        isRestarting = false; restartDeadline = nil; restartWindowUsed = false
        restartTask?.cancel(); restartTask = nil
        let wasDisconnected = connectionStatus == .disconnected
        connectionStatus = .connected
        if showsOffline, let changed = offlineChangedAt, now < changed + .seconds(2) {
            let epoch = generation
            offlineTask = Task { [weak self, syncClock] in
                do { try await syncClock.sleep(for: changed + .seconds(2) - now) } catch { return }
                let recoveredAt = await syncClock.now()
                guard let self, !Task.isCancelled, epoch == generation, transportFailures == 0, offlineChangedAt == changed else { return }
                setOffline(false, at: recoveredAt, reason: "sync_recovered", duration: recoveredAt - changed)
            }
        } else if showsOffline {
            setOffline(false, at: now, reason: "sync_recovered", duration: now - (offlineChangedAt ?? now))
        }
        if wasDisconnected {
            pagingSupport = .unknown
            let epoch = generation
            Task { [weak self] in
                guard let self, epoch == generation else { return }
                await refreshPushConnection()
            }
        }
    }

    private func scheduleSyncRetry(after delay: Duration) {
        guard foreground, api != nil, syncRetryTask == nil else { return }
        let epoch = generation, phase = foregroundGeneration
        syncRetryTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            syncRetryTask = nil
            let now = await syncClock.now()
            guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            if isRestarting || foregroundGraceUntil.map({ now < $0 }) == true { nextSnapshotAt = .zero }
            await enqueueRefresh(.snapshot, immediate: true)
        }
    }

    private func beginRestart() async {
        guard !restartWindowUsed else { return }
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, !restartWindowUsed else { return }
        restartWindowUsed = true; isRestarting = true; isRevalidating = true; isCheckingConnection = false
        transportFailures = 0; firstTransportFailure = nil
        offlineTask?.cancel(); offlineTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
        fallbackTask?.cancel(); fallbackTask = nil
        let deadline = now + .seconds(30)
        restartDeadline = deadline
        if socketTask == nil { socketFailed() }
        restartTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: .seconds(30)) } catch { return }
            guard let self, !Task.isCancelled, restartDeadline == deadline else { return }
            isRestarting = false; restartDeadline = nil; restartTask = nil
            isCheckingConnection = true
            scheduleSyncRetry(after: .zero)
        }
    }

    private func resetConnectionEvidence() {
        offlineTask?.cancel(); offlineTask = nil
        restartTask?.cancel(); restartTask = nil
        restartDeadline = nil; restartWindowUsed = false; isRestarting = false
        transportFailures = 0; firstTransportFailure = nil; foregroundGraceUntil = nil; retriedConsistencyFailure = false
        isCheckingConnection = false
        if showsOffline {
            // Logout/host replacement ends the old connection's display lifetime.
            setOffline(false, at: .seconds(ProcessInfo.processInfo.systemUptime), reason: "session_ended", duration: .zero)
        }
        offlineChangedAt = nil
    }

    func networkPathChanged(satisfied: Bool) {
        let restored = pathWasSatisfied == false && satisfied
        pathWasSatisfied = satisfied
        guard restored, foreground, api != nil else { return }
        socketFailures = 0; restFailures = 0
        reconnectTask?.cancel(); reconnectTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        nextSnapshotAt = .zero
        let epoch = generation, phase = foregroundGeneration
        Task { [weak self] in
            guard let self else { return }
            let now = await syncClock.now()
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            if !socketIsHealthy(at: now) { stopSocket(); startSocket() }
            await enqueueRefresh(.all, immediate: true)
        }
    }

    private func stopRequests() {
        offlineTask?.cancel(); offlineTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        catalogDiscoveryTask?.cancel(); catalogDiscoveryTask = nil
        modelsTask?.cancel(); modelsTask = nil
        modelsRequestID = UUID()
        cancelHistoryLoad(); invalidateCoordinator(); stopSocket()
        fallbackTask?.cancel(); fallbackTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
    }
    private func clearReadError() {
        if let lastReadError, errorMessage == lastReadError { errorMessage = nil }
        lastReadError = nil
    }
    private func handle(_ error: Error) {
        errorMessage = error.localizedDescription
        if (error as? APIError)?.status == 401 {
            resetConnectionEvidence()
            beginPushLogout(); clearHostNavigation()
            NotificationInbox.shared.discardPending()
            stopRequests(); resetReadCollections(); projectCache.removeAll(); validatedProjectGeneration = nil; validatedWriteGeneration = nil
            generation = UUID(); projectGeneration = UUID()
            realtimeStatus = .blocked; isRevalidating = true
            api = nil; apiOutage = nil; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
            terminalLeases.removeAll()
            drafts.selectNamespace("unassigned"); writeNamespace = "unassigned"
            writeRevisions = nil; settingsEdit = nil; settingsConflict = nil
            pendingActions.removeAll()
            connectionStatus = .failed
            if persistCredentials { KeychainStore.remove(for: endpoint) }
            accessCode = ""
        }
    }
    private func mutate<T: Sendable>(_ key: String, refreshAfter: Bool = true, operation: (APIClient) async throws -> T) async -> T? {
        await perform(key, refreshAfter: refreshAfter, operation: operation).value
    }
    /// Like `mutate`, but also returns the server/transport error so callers can tell "the server refused" from
    /// "we never heard back". `error == nil` with no value means the request was not sent.
    private func perform<T: Sendable>(_ key: String, refreshAfter: Bool = true, allowArchived: Bool = false, cancellationAware: Bool = false, deferRefusalToReceipt: Bool = false, ownsPendingAction: Bool = false, operation: (APIClient) async throws -> T) async -> (value: T?, error: Error?) {
        guard !isDemo else { errorMessage = "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 바꿀 수 있습니다."; return (nil, nil) }
        guard let api, canWrite || (allowArchived && connectionStatus == .connected && !isRevalidating && !isDemo) else { errorMessage = isArchive ? "보관한 프로젝트는 읽기 전용입니다." : "서버에 연결된 뒤에 바꿀 수 있습니다."; return (nil, nil) }
        guard ownsPendingAction || !pendingActions.contains(key) else { return (nil, nil) }
        let epoch = generation
        pendingActions.insert(key); errorMessage = nil
        if key.hasPrefix("terminal:") { terminalWindowNotices.removeValue(forKey: String(key.dropFirst("terminal:".count))) }
        defer { if epoch == generation, !ownsPendingAction { pendingActions.remove(key) } }
        do {
            let result = try await operation(api)
            if cancellationAware && Task.isCancelled { return (nil, nil) }
            guard epoch == generation else { return (nil, nil) }
            if refreshAfter { await refresh() }
            guard epoch == generation else { return (nil, nil) }
            return (result, nil)
        } catch {
            guard epoch == generation else { return (nil, error) }
            if cancellationAware && Task.isCancelled { return (nil, error) }
            if key.hasPrefix("terminal:"), terminalRefusalIsLocal(memberID: String(key.dropFirst("terminal:".count)), error: error.localizedDescription) {
                terminalWindowNotices[String(key.dropFirst("terminal:".count))] = error.localizedDescription
            }
            let deferredRefusal = deferRefusalToReceipt && Self.definiteRefusal(error) && (error as? APIError)?.status != 401
            if !deferredRefusal && (!key.hasPrefix("terminal:") || !terminalRefusalIsLocal(memberID: String(key.dropFirst("terminal:".count)), error: error.localizedDescription)) {
                handle(error)
            }
            // A conflict means our copy is stale: show the truth right away. A missing terminal
            // is definitive; do not reconcile its in-flight operation before recording the refusal.
            if !deferredRefusal, (error as? APIError)?.status == 409, !(key.hasPrefix("terminal:") && error.localizedDescription.contains("No core terminal for member")) {
                if !ownsPendingAction { pendingActions.remove(key) }
                await refresh()
            }
            return (nil, error)
        }
    }

    /// The caller may pass the shared composer DraftStore. The immutable snapshot is durable before POST.
    @discardableResult func sendMessage(text: String, targetMemberID: String? = nil, attachmentIDs: [String] = [], contextFileID: String? = nil, draftDidDetach: (@MainActor () -> Void)? = nil) async -> Bool {
        let noticeNamespace = writeNamespace
        let noticeDraftKey = DraftStore.key(project: selectedProjectID, target: targetMemberID)
        let noticeKey = Self.scoped(noticeNamespace, noticeDraftKey)
        messageSendNotices.removeValue(forKey: noticeKey)
        var completed = false
        var explainedFailure = false
        var failureReason = "연결이나 초안이 바뀌어 보내지 않았습니다. 글을 확인하고 다시 보내 주세요."
        defer {
            // A persisted refusal already explains the failure. Every other false result also
            // gets a composer-scoped explanation, including early guards and local errors.
            if completed || explainedFailure { messageSendNotices.removeValue(forKey: noticeKey) }
            else { messageSendNotices[noticeKey] = failureReason }
        }
        guard !isDemo else { failureReason = "샘플은 읽기 전용입니다."; errorMessage = failureReason; return false }
        guard canWrite else { failureReason = writeBlockedReason ?? "최신 상태를 확인한 뒤 보내 주세요."; return false }
        guard let projectID = selectedProjectID else { failureReason = "프로젝트를 고른 뒤 보내 주세요."; return false }
        guard let submissions else { failureReason = "전송 기록을 준비하지 못했습니다. 다시 연결해 주세요."; return false }
        guard !isSending(projectID: projectID, targetMemberID: targetMemberID) else {
            failureReason = "앞선 글을 보내는 중입니다. 끝난 뒤 다시 보내 주세요."; return false
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty else {
            failureReason = "보낼 글이나 첨부를 넣어 주세요."; return false
        }
        let epoch = generation
        let actionKey = sendActionKey(projectID: projectID, targetMemberID: targetMemberID)
        pendingActions.insert(actionKey)
        defer { if epoch == generation { pendingActions.remove(actionKey) } }
        let key = DraftStore.key(project: projectID, target: targetMemberID)
        do {
            // Query unresolved attempts before considering any edited replacement.
            for attempt in submissions.messages(namespace: writeNamespace) where attempt.draft.key == key
                && (attempt.status == .checking || (attempt.status == .accepted && !attempt.draftConsumed)) {
                if attempt.status == .checking, strictWriteContract {
                    failureReason = "접수 확인 중입니다. 결과를 확인한 뒤 다시 보내 주세요."
                    guard await reconcileMessage(attempt.id), epoch == generation else { return false }
                    if let current = submissions.messageAttempt(id: attempt.id), current.restoredDraft != nil {
                        failureReason = "접수 확인 뒤 입력칸의 글이 바뀌었습니다. 확인하고 다시 보내 주세요."
                        guard drafts.text(for: key) == text, drafts.files(for: key).map(\.id) == attachmentIDs else { return false }
                    }
                }
                if let current = submissions.messageAttempt(id: attempt.id), current.status == .accepted,
                   current.draft.text == text, current.request.attachmentIds == attachmentIDs {
                    try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                    completed = true
                    return true
                }
            }
            // A legacy explicit retry uses the immutable attempt, never copies its sent text into the next draft.
            let retry = submissions.messages(namespace: writeNamespace).first {
                $0.draft.key == key && $0.status == .checking && !strictWriteContract
                    && $0.draft.text == text && $0.request.attachmentIds == attachmentIDs
            }
            if retry == nil { drafts.setText(text, for: key) }
            let files = retry?.draft.attachments ?? drafts.files(for: key)
            guard Set(files.map(\.id)) == Set(attachmentIDs), files.count == attachmentIDs.count else {
                throw APIError(status: 0, message: "첨부 초안을 확인해 주세요. 누락된 첨부를 빼고 보내지 않습니다.")
            }
            if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
            let attempt = try retry ?? submissions.prepareMessage(projectID: projectID, targetMemberID: targetMemberID, draft: drafts.snapshot(for: key), contextFileID: contextFileID, clearsDraft: true)
            // No suspension between the durable intent, snapshot and durable clear. Both platforms share this path.
            let detached = try submissions.detachMessage(id: attempt.id, drafts: drafts)
            if retry == nil, attempt.handoffID != nil, !detached {
                throw APIError(status: 0, message: "초안이 바뀌어 보내지 않았습니다. 입력칸을 확인하고 다시 보내 주세요.")
            }
            if detached { draftDidDetach?() }
            let outcome: (value: Message?, error: Error?) = await perform(actionKey, refreshAfter: false, deferRefusalToReceipt: true, ownsPendingAction: true) { api in
                let request = try submissions.beginMessage(id: attempt.id, allowUnconfirmedRetry: !strictWriteContract)
                return try await api.sendMessage(projectID: projectID, request: request, contractVersion: strictWriteContract ? 2 : nil)
            }
            // A 401 can invalidate the connection inside perform. Restore its proven refusal
            // in the captured namespace even then; never change the newly selected host.
            if Self.definiteRefusal(outcome.error)
                || submissions.messageAttempt(id: attempt.id)?.status == .prepared
                || submissions.messageAttempt(id: attempt.id)?.status == .notAccepted {
                try submissions.refuseMessage(id: attempt.id, reason: outcome.error?.localizedDescription ?? "서버가 접수하지 않았습니다")
                try submissions.restoreMessage(id: attempt.id, drafts: drafts)
                explainedFailure = true
                return false
            }
            guard epoch == generation else { return false }
            if let message = outcome.value {
                try submissions.acceptMessage(id: attempt.id, message: message)
                receiveHistoryMessage(message)
                try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                await refresh()
                completed = true
                return true
            }
            if outcome.error != nil {
                failureReason = "접수 확인 중입니다. 같은 전송 ID로 조회합니다."
                errorMessage = failureReason
            } else { failureReason = errorMessage ?? failureReason }
        } catch {
            guard epoch == generation else { return false }
            if case SubmissionError.unresolvedAttempt = error {
                failureReason = "이전 글의 접수 결과를 먼저 확인해 주세요. 글은 입력칸에 남아 있습니다."
                errorMessage = failureReason
            } else { failureReason = error.localizedDescription; handle(error) }
        }
        return false
    }

    /// Explicit retry sends the retained immutable attempt and never detaches the user's next draft.
    @discardableResult func retryFailedMessage(id: String) async -> Bool {
        guard let attempt = submissions?.messageAttempt(id: id) else {
            explainMessageSendBlock("보내지 못한 글의 기록을 찾지 못했습니다.", targetMemberID: nil)
            return false
        }
        let noticeKey = Self.scoped(attempt.namespace, attempt.draft.key)
        messageSendNotices.removeValue(forKey: noticeKey)
        var completed = false
        var failureReason = "지금은 다시 보낼 수 없습니다. 연결과 이전 전송 결과를 확인해 주세요."
        defer {
            if completed { messageSendNotices.removeValue(forKey: noticeKey) }
            else { messageSendNotices[noticeKey] = failureReason }
        }
        guard canWrite, let submissions, let attempt = submissions.messageAttempt(id: id),
              attempt.namespace == writeNamespace, attempt.projectID == selectedProjectID,
              attempt.retainsFailedMessage,
              attempt.status == .refused || attempt.status == .notAccepted,
              !isSending(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID) else { return false }
        let epoch = generation
        let actionKey = sendActionKey(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID)
        pendingActions.insert(actionKey)
        defer { if epoch == generation { pendingActions.remove(actionKey) } }
        do {
            let outcome: (value: Message?, error: Error?) = await perform(actionKey, refreshAfter: false,
                deferRefusalToReceipt: true, ownsPendingAction: true) { api in
                let request = try submissions.beginMessage(id: id)
                return try await api.sendMessage(projectID: attempt.projectID, request: request,
                                                 contractVersion: strictWriteContract ? 2 : nil)
            }
            if Self.definiteRefusal(outcome.error) {
                try submissions.refuseMessage(id: id, reason: outcome.error?.localizedDescription)
                completed = true // The retained failure notice explains this definitive rejection.
                return false
            }
            guard epoch == generation else { return false }
            if let message = outcome.value {
                try submissions.acceptMessage(id: id, message: message)
                receiveHistoryMessage(message)
                try submissions.consumeAccepted(id: id, drafts: drafts)
                await refresh()
                completed = true
                return true
            }
            failureReason = outcome.error == nil ? (errorMessage ?? failureReason) : "접수 확인 중입니다. 같은 전송 ID로 조회합니다."
        } catch {
            failureReason = error.localizedDescription
            if epoch == generation { handle(error) }
        }
        return false
    }

    private func reconcileMessage(_ id: String) async -> Bool {
        guard canWrite, let api, let submissions else { return false }
        let epoch = generation
        do {
            _ = try await submissions.reconcileMessage(id: id, using: api)
            guard epoch == generation else { return false }
            if submissions.messageAttempt(id: id)?.status == .accepted {
                if let message = submissions.messageAttempt(id: id)?.message { receiveHistoryMessage(message) }
                try submissions.consumeAccepted(id: id, drafts: drafts)
            } else if submissions.messageAttempt(id: id)?.status == .notAccepted {
                try submissions.restoreMessage(id: id, drafts: drafts)
            }
            return true
        } catch {
            guard epoch == generation else { return false }
            handle(error)
            if canWrite {
                // A missing lookup endpoint, malformed response or transport failure is not
                // proof of absence. Keep the immutable attempt and make the pending result explicit.
                errorMessage = "접수 확인 중입니다. 같은 전송 ID로 조회합니다. (\(error.localizedDescription))"
            }
            return false
        }
    }

    /// Captures host, connection and draft deletion generations before starting an upload.
    @discardableResult func upload(data: Data, filename: String, mime: String, targetMemberID: String? = nil) async -> Attachment? {
        guard canWrite, let api, let projectID = selectedProjectID else { return nil }
        let epoch = generation, projectEpoch = projectGeneration
        let token = drafts.uploadToken(for: DraftStore.key(project: projectID, target: targetMemberID))
        do {
            let file = try await api.upload(data: data, filename: filename, mime: mime, projectID: projectID, targetMemberID: targetMemberID)
            guard epoch == generation, projectEpoch == projectGeneration, canWrite, selectedProjectID == projectID,
                  drafts.completeUpload(file, token: token) else { return nil }
            if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
            return file
        } catch { if epoch == generation { handle(error) }; return nil }
    }

    @discardableResult func resumeUsageLimit(_ decision: Decision) async -> Bool {
        guard decision.kind == "usage_limit", decision.status == "open" else { return false }
        return await answerDecision(decision, choice: UsageLimitInfo.resumeChoice, note: nil)
    }

    @discardableResult func answerDecision(_ decision: Decision, choice: String?, note: String?) async -> Bool {
        let req = AnswerRequest(choice: choice, note: note, batch: false, expectedVersion: decision.updatedAt)
        let result: Decision? = await mutate("decision:\(decision.id)") { api in
            try await api.send("/api/decisions/\(APIClient.segment(decision.id))/answer", body: req, contractVersion: strictWriteContract ? 2 : nil)
        }
        return result != nil
    }
    /// Kept for existing screens; detailed per-card evidence is also exposed in batchResults.
    func answerBatch(_ decisions: [Decision], notes: [String: String] = [:]) async -> (sent: Int, failures: [String]) {
        let results = await answerBatchResults(decisions, notes: notes)
        return (results.values.filter { $0 == .accepted }.count,
                decisions.filter { results[$0.id] != .accepted }.map(\.title))
    }

    func answerBatchResults(_ decisions: [Decision], notes: [String: String] = [:]) async -> [String: CardWriteStatus] {
        let epoch = generation, namespace = writeNamespace
        var results: [String: CardWriteStatus] = [:]
        for decision in decisions {
            guard epoch == generation, canWrite, decision.kind != "usage_limit",
                  let rec = decision.rec, decision.options.contains(where: { $0.k == rec }) else {
                results[decision.id] = .notSent; continue
            }
            let memo = drafts.memo(for: decision.id)
            let note = notes[decision.id].flatMap { $0.isEmpty ? nil : $0 }
            let req = AnswerRequest(choice: rec, note: note, batch: true, expectedVersion: decision.updatedAt)
            let outcome: (value: Decision?, error: Error?) = await perform("decision:\(decision.id)", refreshAfter: false) { api in
                try await api.send("/api/decisions/\(APIClient.segment(decision.id))/answer", body: req, contractVersion: strictWriteContract ? 2 : nil)
            }
            guard epoch == generation else { results[decision.id] = .unknown; continue }
            if let value = outcome.value, value.id == decision.id, value.status == "answered", value.choice == rec, value.note == note {
                results[decision.id] = .accepted
                if drafts.namespace == namespace, drafts.memo(for: decision.id) == memo,
                   memo == note { drafts.clearMemo(decision.id) }
            } else if let error = outcome.error as? APIError, error.status == 409 { results[decision.id] = .conflict }
            else if outcome.error != nil || outcome.value != nil { results[decision.id] = Self.definiteRefusal(outcome.error) ? .refused : .unknown }
            else { results[decision.id] = .notSent }
        }
        if epoch == generation { batchResults = results; await refresh() }
        return results
    }
    /// Only decisions the AI closed (closeKind set) can be reopened.
    @discardableResult func reopenDecision(_ decision: Decision) async -> Bool {
        let result: Decision? = await mutate("decision:\(decision.id)") { api in
            try await api.request("/api/decisions/\(APIClient.segment(decision.id))/reopen", method: "POST")
        }
        return result != nil
    }
    /// Re-sends a failed message with the same id, target and attachments (the daemon treats it as a retry).
    @discardableResult func resend(_ message: Message) async -> Bool {
        guard let projectID = selectedProjectID, message.projectId == projectID, message.mine, message.delivery == "failed" else { return false }
        let request = SendMessageRequest(id: message.id, text: message.body, targetMemberId: message.targetMemberId, attachmentIds: message.attachments.map(\.id))
        let result: Message? = await mutate(sendActionKey(projectID: projectID, targetMemberID: message.targetMemberId), refreshAfter: false) { api in
            try await api.send("/api/projects/\(APIClient.segment(projectID))/messages", body: request)
        }
        if let result { receiveHistoryMessage(result); await refresh() }
        return result != nil
    }
    @discardableResult func startConductor() async -> Bool {
        guard let projectID = selectedProjectID else { return false }
        let result: Member? = await mutate("conductor-start") { api in
            try await api.request("/api/projects/\(APIClient.segment(projectID))/conductor/start", method: "POST", timeout: 150)
        }
        return result != nil
    }
    /// Asks the conductor to align the board with reality. Returns whether such a request was already waiting.
    func tidyBoard() async -> Bool? {
        struct Result: Decodable, Sendable { let already: Bool? }
        guard let projectID = selectedProjectID else { return nil }
        let result: Result? = await mutate("tidy") { api in
            try await api.request("/api/projects/\(APIClient.segment(projectID))/tidy", method: "POST", timeout: 150)
        }
        return result.map { $0.already ?? false }
    }
    /// Without force the daemon refuses while the member works, waits on a decision or has queued input.
    @discardableResult func sleepMember(_ member: Member, force: Bool = false) async -> Bool {
        struct Request: Encodable, Sendable { let force: Bool }
        let result: Member? = await mutate("member:\(member.id)") { api in
            try await api.send("/api/members/\(APIClient.segment(member.id))/sleep", body: Request(force: force), timeout: 150)
        }
        return result != nil
    }
    /// Removes a manually joined worker from the roster (the only action available for manual sessions).
    @discardableResult func closeMember(_ member: Member) async -> Bool {
        struct Result: Decodable, Sendable { let ok: Bool? }
        let result: Result? = await mutate("member:\(member.id)") { api in
            try await api.request("/api/members/\(APIClient.segment(member.id))/close", method: "POST")
        }
        return result != nil
    }
    // MARK: Phone pairing (QR)

    /// Mac: asks the daemon for a one-time code to show as a QR. nil in sample mode or when offline.
    func startPairing() async -> PairStart? {
        await mutate("pair-start", refreshAfter: false) { api in
            try await api.request("/api/pair/start", method: "POST")
        }
    }

    /// Phone: trades the QR's one-time code for the access code over Tailscale, then connects like a manual login.
    @discardableResult func pair(with link: PairingLink, device: String) async -> Bool {
        guard !isDemo else { errorMessage = "샘플 모드에서는 연결하지 않습니다."; return false }
        guard !isPairing else { return false }
        errorMessage = nil
        isPairing = true
        defer { isPairing = false }
        let pairingEpoch = generation
        do {
            let result = try await PairingClient.claim(link, device: device, session: injectedSession)
            guard pairingEpoch == generation, !Task.isCancelled else { return false }
            endpoint = result.endpoint
            accessCode = result.accessCode
            await connect()
            guard connectionStatus == .connected, endpoint == result.endpoint,
                  accessCode == result.accessCode, let client = api else { return false }
            // The shared access code cannot identify a QR. ACK only on the authenticated client
            // established above; older servers omit the token and remain compatible.
            if let token = result.confirmationToken {
                _ = try? await client.acknowledgePairing(code: link.code, confirmationToken: token)
            }
            return api === client && connectionStatus == .connected
        } catch {
            if pairingEpoch == generation { errorMessage = friendlyLoadError(error, what: "Mac 연결", verb: "확인하지") }
            return false
        }
    }

    /// T8 loads this before reading body; returned data remains bound to the current API actor.
    func fileBody(id: String, forceRefresh: Bool = false) async throws -> FileDoc {
        guard let api else { throw APIError(status: 0, message: "연결한 뒤 자료를 열어 주세요.") }
        let file = try await api.fileBody(id: id, forceRefresh: forceRefresh)
        guard self.api === api, file.projectId == selectedProjectID else { throw APIError(status: 0, message: "현재 프로젝트의 자료를 선택해 주세요.") }
        return file
    }

    @discardableResult func setTodoDone(_ todo: Todo, done: Bool, note: String? = nil, fileIDs: [String] = []) async -> Bool {
        if !strictWriteContract {
            let result: Todo? = await mutate("todo:\(todo.id)") { api in
                try await api.completeTodo(id: todo.id, done: done, note: note, fileIDs: fileIDs).todo
            }
            return result != nil
        }
        guard canWrite, let revision = writeRevisions?.todos?[todo.id],
              reviewedTodos[todo.id].map({ Self.same($0, todo) }) == true,
              todoWrites[todo.id] != .checking, todoWrites[todo.id] != .sending else {
            errorMessage = "최신 업무 상태를 확인한 뒤 변경하세요."; return false
        }
        return await submitTodoCompletion(PendingTodo(id: todo.id, namespace: writeNamespace, revision: revision,
                                                      done: done, note: note, fileIds: fileIDs))
    }

    @discardableResult func dropTodo(_ todo: Todo, reason: String? = nil) async -> Bool {
        if !strictWriteContract {
            let result: Todo? = await mutate("todo:\(todo.id)") { api in
                try await api.dropTodo(id: todo.id, reason: reason).todo
            }
            return result != nil
        }
        guard canWrite, let revision = writeRevisions?.todos?[todo.id],
              reviewedTodos[todo.id].map({ Self.same($0, todo) }) == true,
              todoWrites[todo.id] != .checking, todoWrites[todo.id] != .sending else {
            errorMessage = "최신 업무 상태를 확인한 뒤 변경하세요."; return false
        }
        return await submitTodoCompletion(PendingTodo(id: todo.id, namespace: writeNamespace, revision: revision,
                                                      done: true, note: nil, fileIds: nil, dropReason: reason, dropped: true))
    }

    /// Explicit retry only. A restored uncertain write is queried, never automatically submitted.
    @discardableResult func retryTodoCompletion(_ todo: Todo) async -> Bool {
        guard strictWriteContract, canWrite,
              let pending = journal.todos[Self.scoped(writeNamespace, todo.id)],
              todoWrites[todo.id] != .sending,
              writeRevisions?.todos?[todo.id] == pending.revision,
              reviewedTodos[todo.id].map({ Self.same($0, todo) }) == true else { return false }
        return await submitTodoCompletion(pending)
    }

    private func submitTodoCompletion(_ pending: PendingTodo) async -> Bool {
        let epoch = generation, namespace = pending.namespace
        let id = pending.id, revision = pending.revision, done = pending.done
        do {
            try saveJournal { $0.todos[Self.scoped(namespace, id)] = pending }
        } catch { handle(error); return false }
        todoWrites[id] = .sending
        let outcome = await perform("todo:\(id)", refreshAfter: false) { api in
            if pending.dropped == true { return try await api.dropTodo(id: id, reason: pending.dropReason, revision: revision) }
            return try await api.completeTodo(id: id, done: done, note: pending.note, fileIDs: pending.fileIds ?? [], revision: revision)
        }
        guard epoch == generation else { return false }
        if let result = outcome.value, result.todo.id == id, result.todo.done == done, (pending.dropped != true || result.todo.outcome == "dropped"), result.revision >= revision {
            todoWrites[id] = .confirmed
            writeRevisions?.todos?[id] = result.revision
            if let index = state?.todos.firstIndex(where: { $0.id == id }) { state?.todos[index] = result.todo }
            do { try saveJournal { $0.todos.removeValue(forKey: Self.scoped(namespace, id)) } }
            catch { handle(error) }
            await refresh()
            return true
        }
        todoWrites[id] = Self.definiteRefusal(outcome.error) ? .conflict : .checking
        if todoWrites[id] == .conflict {
            do { try saveJournal { $0.todos.removeValue(forKey: Self.scoped(namespace, id)) } }
            catch { handle(error) }
        } else { errorMessage = "업무 변경 결과 확인 중입니다." }
        await refreshWriteContext()
        return false
    }
    @discardableResult func createProject(name: String, cwd: String, goal: String = "", provider: String = "claude") async -> Bool {
        let req = CreateProjectRequest(name: name, cwd: cwd, goal: goal, startConductor: true, chiefCli: provider)
        let result: Project? = await mutate("create-project") { api in try await api.send("/api/projects", body: req, timeout: 150) }
        if let result { await selectProject(id: result.id) }
        return result != nil
    }
    @discardableResult func createMember(name: String, role: String = "", provider: String = "claude", model: String? = nil) async -> Bool {
        guard let projectID = selectedProjectID else { return false }
        let req = CreateMemberRequest(name: name, role: role, cli: provider, modelOverride: model)
        let result: Member? = await mutate("create-member") { api in try await api.send("/api/projects/\(APIClient.segment(projectID))/members", body: req, timeout: 150) }
        return result != nil
    }
    @discardableResult func memberAction(_ member: Member, action: String) async -> Bool {
        guard ["interrupt", "resume", "sleep", "compact", "reopen-with-tools", "fresh-session"].contains(action) else { errorMessage = "지원하지 않는 팀원 조작입니다."; return false }
        if action == "fresh-session" { return await freshSession(member) }
        if action == "compact" { return await compactMember(member) }
        let result: Member? = await mutate("member:\(member.id)") { api in try await api.request("/api/members/\(APIClient.segment(member.id))/\(action)", method: "POST", timeout: 150) }
        return result != nil
    }

    func canOpenTerminal(_ member: Member) -> Bool {
        !terminalWake.members.contains(member.id)
            && (!TerminalAvailability.needsWake(member)
                || (canWrite && !pendingActions.contains("member:\(member.id)")))
    }

    /// Uses the same write guard, pending member key and error handling as other member actions.
    @discardableResult func wakeTerminal(_ member: Member, timeout: Duration = .seconds(20)) async -> Bool {
        guard canWrite, !pendingActions.contains("member:\(member.id)"),
              TerminalAvailability.needsWake(member) else { return false }
        let namespace = writeNamespace
        let epoch = generation, projectEpoch = projectGeneration
        let outcome = await terminalWake.wake(memberID: member.id, timeout: timeout, resume: {
            let result: (value: Member?, error: Error?) = await self.perform("member:\(member.id)", refreshAfter: false, cancellationAware: true) { api in
                try await api.request("/api/members/\(APIClient.segment(member.id))/resume", method: "POST", timeout: 20)
            }
            if result.value != nil { return nil }
            return result.error?.localizedDescription ?? self.errorMessage ?? "요청을 보낼 수 없습니다"
        }, current: {
            self.members.first { $0.id == member.id }
        }, allowed: {
            self.writeNamespace == namespace && self.generation == epoch && self.projectGeneration == projectEpoch && self.canWrite
        })
        guard writeNamespace == namespace, generation == epoch, projectGeneration == projectEpoch else { return false }
        if let message = outcome.message { errorMessage = message }
        return outcome == .ready && canWrite && members.first(where: { $0.id == member.id }).map(TerminalAvailability.isReady) == true
    }
    @discardableResult func patchMember(_ member: Member, provider: String, model: String?, effort: String?) async -> Bool {
        let req = PatchMemberRequest(cli: provider, modelOverride: model, effortOverride: effort)
        if !strictWriteContract {
            let result: Member? = await mutate("member:\(member.id)") { api in
                try await api.send("/api/members/\(APIClient.segment(member.id))", method: "PATCH", body: req)
            }
            return result != nil
        }
        guard let revision = writeRevisions?.members?[member.id]?.configRevision,
              let reviewed = reviewedMembers[member.id], Self.same(reviewed, member) else {
            errorMessage = "최신 직원 설정을 확인한 뒤 변경하세요."; return false
        }
        let result = await mutate("member:\(member.id)") { api in
            try await api.patchMember(id: member.id, request: req, revision: revision)
        }
        return result != nil
    }

    /// Call when opening an editor; its baseline remains pinned while background sync advances.
    @discardableResult func beginSettingsEditing() -> SettingsEdit? {
        guard let revision = writeRevisions?.settings, let settings = reviewedSettings else { return nil }
        let edit = SettingsEdit(base: settings, draft: settings, revision: revision)
        settingsEdit = edit; settingsConflict = nil
        return edit
    }

    func setSettingsDraft(_ settings: Settings) {
        if settingsEdit == nil { _ = beginSettingsEditing() }
        settingsEdit?.draft = settings
    }

    @discardableResult func updateSettings(_ settings: Settings) async -> Bool {
        guard canWrite, !pendingActions.contains("settings") else { return false }
        if !strictWriteContract {
            let result: Settings? = await mutate("settings") { api in
                try await api.send("/api/settings", method: "PUT", body: settings)
            }
            return result != nil
        }
        if settingsEdit == nil { _ = beginSettingsEditing() }
        guard var edit = settingsEdit else { errorMessage = "이 호스트의 설정 revision을 확인할 수 없습니다."; return false }
        edit.draft = settings; settingsEdit = edit
        let patch = Self.settingsPatch(base: edit.base, draft: settings)
        guard !Self.empty(patch) else { return true }
        let epoch = generation
        let result = await perform("settings", refreshAfter: false) { api in
            try await api.patchSettings(request: patch, revision: edit.revision)
        }
        guard epoch == generation else { return false }
        guard let saved = result.value else {
            await refreshWriteContext()
            if epoch == generation { settingsConflict = reviewedSettings }
            return false
        }
        // A pending invalidation survives the cancelled pre-CAS read.
        refreshTask?.cancel(); refreshGeneration = UUID()
        writeContextGeneration = UUID()
        if saved.revision >= (writeRevisions?.settings ?? 0) {
            bootstrap?.settings = saved.settings; reviewedSettings = saved.settings
            writeRevisions?.settings = saved.revision
        }
        if let current = settingsEdit, !Self.same(current.draft, settings) {
            // A follow-up edit belongs to the next CAS; the accepted fields become its baseline.
            settingsEdit = SettingsEdit(base: settings, draft: current.draft, revision: saved.revision)
        } else { settingsEdit = nil }
        settingsConflict = nil
        dirty.insert(.diagnostics)
        await refresh()
        return true
    }

    @discardableResult func freshSession(_ member: Member) async -> Bool {
        if !strictWriteContract {
            let result: Member? = await mutate("member:\(member.id)") { api in
                try await api.request("/api/members/\(APIClient.segment(member.id))/fresh-session", method: "POST", timeout: 150)
            }
            return result != nil
        }
        guard canWrite, let version = writeRevisions?.members?[member.id],
              !pendingActions.contains("member:\(member.id)"),
              reviewedMembers[member.id].map({ Self.same($0, member) }) == true else {
            errorMessage = "최신 세션 세대를 확인한 뒤 변경하세요."; return false
        }
        let epoch = generation
        if let existing = journal.operations.values.first(where: {
            $0.namespace == writeNamespace && $0.memberID == member.id && $0.kind == .freshSession
                && ($0.status == .pending || $0.status == .unknown)
        }) {
            await reconcileOperation(existing)
            return epoch == generation && operationResults[existing.id]?.status == .applied
        }
        let tracked = TrackedOperation(id: UUID().uuidString, namespace: writeNamespace, memberID: member.id,
                                       kind: .freshSession, sessionGeneration: version.sessionGeneration, order: (journal.operations.values.map(\.order).max() ?? -1) + 1)
        do { try saveJournal { $0.operations[tracked.id] = tracked } }
        catch { handle(error); return false }
        let result = await perform("member:\(member.id)", refreshAfter: false, deferRefusalToReceipt: true) { api in
            try await api.freshSession(memberID: member.id, request: FreshSessionRequest(operationId: tracked.id, expectedSessionGeneration: tracked.sessionGeneration))
        }
        guard epoch == generation else { return false }
        if let receipt = result.value {
            do { try applyReceipt(receipt, tracked: tracked) } catch { handle(error) }
        } else {
            await recordOperationFailure(tracked, error: result.error)
            if journal.operations[tracked.id]?.status != .refused { await reconcileOperation(tracked) }
        }
        if operationResults[tracked.id]?.status == .applied { await refresh(); return true }
        return false
    }

    func readCLIApproval(_ member: Member) async throws -> CLIApprovalPrompt? {
        guard !isDemo, member.canReadCLIApproval, let api else { return nil }
        let result: CLIApprovalResponse = try await api.request("/api/members/\(APIClient.segment(member.id))/approval")
        return result.approval
    }

    @discardableResult func answerCLIApproval(_ member: Member, prompt: CLIApprovalPrompt, option: Int) async -> Bool {
        let lease = terminalLeases[member.id]
        let manualControl = lease?.leaseId != nil && (lease?.expiresAt.map { $0 > Date().timeIntervalSince1970 * 1000 } ?? true)
        guard member.projectId == selectedProjectID,
              members.first(where: { $0.id == member.id })?.canReadCLIApproval == true,
              !manualControl else {
            errorMessage = "현재 승인 창을 확인할 수 없습니다. 직접 조작을 끝내고 다시 읽어 주세요."
            return false
        }
        struct Result: Decodable, Sendable { let ok: Bool }
        let result: Result? = await mutate("approval:\(member.id)") { api in
            try await api.send("/api/members/\(APIClient.segment(member.id))/approval",
                               body: CLIApprovalAnswer(fingerprint: prompt.fingerprint, option: option))
        }
        return result?.ok == true
    }

    // Sheet ownership is independent of the employee's shared status strip. Queue
    // handoffs so a late claim/close can never release the next sheet's lease.
    @ObservationIgnored private var terminalWindows: [UUID: String] = [:]
    private var terminalWindowNotices: [String: String] = [:]
    func terminalWindowNotice(memberID: String) -> String? { terminalWindowNotices[memberID] }
    func terminalWindowOpened(memberID: String, owner: UUID) { terminalWindows[owner] = memberID }
    func terminalWindowClosed(owner: UUID) {
        if let memberID = terminalWindows.removeValue(forKey: owner), !terminalWindows.values.contains(memberID) {
            terminalWindowNotices.removeValue(forKey: memberID)
        }
    }
    private func terminalRefusalIsLocal(memberID: String, error: String?) -> Bool {
        error?.contains("No core terminal for member") == true && terminalWindows.values.contains(memberID)
    }

    @ObservationIgnored private var terminalSessionTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var terminalSessionWanted: [String: UUID] = [:]
    @ObservationIgnored private var terminalSessionHeld: [String: (owner: UUID, leaseID: String, namespace: String)] = [:]
    @ObservationIgnored private var cancelledTerminalClaims: Set<String> = []

    func claimTerminalSession(_ member: Member, owner: UUID) async -> TerminalLease? {
        guard !cancelledTerminalClaims.contains(owner.uuidString) else { return nil }
        let namespace = writeNamespace
        terminalSessionWanted[member.id] = owner
        let previous = terminalSessionTasks[member.id]
        let task = Task<TerminalLease?, Never> {
            await previous?.value
            guard self.writeNamespace == namespace, self.terminalSessionWanted[member.id] == owner else { return nil }
            if let held = self.terminalSessionHeld[member.id], held.namespace == namespace, held.owner != owner {
                guard await self.releaseTerminal(member, expectedLeaseID: held.leaseID) else { return nil }
                self.terminalSessionHeld.removeValue(forKey: member.id)
            }
            guard self.writeNamespace == namespace, self.terminalSessionWanted[member.id] == owner else { return nil }
            guard await self.claimTerminal(member, claimID: owner.uuidString),
                  let lease = self.terminalLeases[member.id], let id = lease.leaseId else { return nil }
            guard self.writeNamespace == namespace else { return nil }
            self.terminalSessionHeld[member.id] = (owner, id, namespace)
            guard self.terminalSessionWanted[member.id] == owner else {
                _ = await self.releaseTerminal(member, expectedLeaseID: id)
                if self.terminalSessionHeld[member.id]?.owner == owner { self.terminalSessionHeld.removeValue(forKey: member.id) }
                return nil
            }
            return lease
        }
        terminalSessionTasks[member.id] = Task { _ = await task.value }
        return await task.value
    }

    func releaseTerminalSession(_ member: Member, owner: UUID) async -> Bool {
        cancelledTerminalClaims.insert(owner.uuidString)
        do {
            let ids = journal.operations.values.filter {
                $0.namespace == writeNamespace && $0.memberID == member.id && $0.action == .claim &&
                submissions?.terminalAttempt(id: $0.id)?.claimID == owner.uuidString
            }.map(\.id)
            if !ids.isEmpty { try saveJournal { journal in for id in ids { journal.operations[id]?.cancelledClaim = true } } }
        } catch { handle(error) }
        if terminalSessionWanted[member.id] == owner { terminalSessionWanted.removeValue(forKey: member.id) }
        let previous = terminalSessionTasks[member.id]
        let task = Task<Bool, Never> {
            await previous?.value
            guard let held = self.terminalSessionHeld[member.id], held.owner == owner, held.namespace == self.writeNamespace else {
                // Closing can follow input/key receipts, not just the claim receipt.
                return await self.recoverCancelledTerminalClaims(memberID: member.id)
            }
            let released = await self.releaseTerminal(member, expectedLeaseID: held.leaseID)
            if released, self.terminalSessionHeld[member.id]?.owner == owner { self.terminalSessionHeld.removeValue(forKey: member.id) }
            return released
        }
        terminalSessionTasks[member.id] = Task { _ = await task.value }
        return await task.value
    }

    /// Cancellation is durable work, independent of whether a lease receipt was already restored.
    /// Run only after restoring the newest lease checkpoint, so an old claim cannot release a new holder.
    private func recoverCancelledTerminalClaims(memberID: String? = nil) async -> Bool {
        let epoch = generation, namespace = writeNamespace
        let claims = journal.operations.values.filter {
            $0.namespace == namespace && $0.action == .claim && $0.cancelledClaim == true &&
                (memberID == nil || $0.memberID == memberID)
        }.sorted { $0.order < $1.order }
        var complete = true
        for claim in claims {
            guard epoch == generation, canWrite else { return false }
            guard let version = writeRevisions?.members?[claim.memberID] else { complete = false; continue }
            var finished = version.sessionGeneration != claim.sessionGeneration || claim.status == .refused
            var endedCheckpointID: String?
            if !finished, claim.status == .applied {
                let latest = journal.operations.values.filter {
                    $0.namespace == namespace && $0.memberID == claim.memberID && $0.kind == .terminalControl &&
                        $0.status == .applied && $0.sessionGeneration == version.sessionGeneration
                }.max { $0.order < $1.order }
                if let latest, latest.order > claim.order, latest.action == .release {
                    finished = true
                } else if let latest, (leaseReceiptOrder[claim.memberID] ?? -1) >= latest.order {
                    // Never recover an old legacy claim until the newest checkpoint is known.
                    // If its lookup failed, keep the intent and retry on the next recovery.
                    if journal.operations[claim.id]?.receipt == nil { await reconcileOperation(claim) }
                    guard epoch == generation, canWrite else { return false }
                    if case .terminalControl(let result) = journal.operations[claim.id]?.receipt?.result,
                       let leaseID = result.leaseId {
                        if terminalLeases[claim.memberID]?.leaseId != leaseID {
                            finished = true // Stream ended, release applied, or a newer holder is already known.
                        } else if terminalReleases[claim.memberID] == nil,
                                  let member = members.first(where: { $0.id == claim.memberID }) {
                            finished = await releaseTerminal(member, expectedLeaseID: leaseID)
                            guard epoch == generation, canWrite else { return false }
                        }
                        if finished, terminalLeases[claim.memberID] == nil { endedCheckpointID = latest.id }
                    }
                }
            }
            if finished {
                do { try saveJournal {
                    $0.operations[claim.id]?.cancelledClaim = false
                    // A confirmed disappearance must survive restart just like an applied release.
                    if let endedCheckpointID { $0.operations[endedCheckpointID]?.leaseEnded = true }
                } }
                catch { handle(error); complete = false }
            } else { complete = false }
        }
        return complete
    }

    func updateTerminalStreamLease(memberID: String, expiresAt: Double) {
        guard let lease = terminalLeases[memberID], let leaseId = lease.leaseId else { return }
        terminalLeases[memberID] = TerminalLease(leaseId: leaseId, expiresAt: expiresAt)
    }
    func terminalStreamLeaseEnded(memberID: String) { terminalLeases.removeValue(forKey: memberID) }

    @discardableResult func claimTerminal(_ member: Member, claimID: String? = nil) async -> Bool {
        if strictWriteContract { return await terminalOperation(member, action: .claim, claimID: claimID) }
        // Passing the lease we still hold renews it; a lost input reply may have extended it on the server past our copy.
        let known = claimID == nil ? terminalLeases[member.id]?.leaseId : nil
        let outcome: (value: TerminalLease?, error: Error?) = await perform("terminal:\(member.id)", refreshAfter: false) { api in
            try await api.terminalControl(memberID: member.id, request: TerminalControlRequest(action: "claim", leaseId: known))
        }
        guard let result = outcome.value, result.leaseId != nil else {
            if outcome.value != nil || Self.leaseGone(outcome.error) { terminalLeases.removeValue(forKey: member.id) }
            return false
        }
        terminalLeases[member.id] = result
        return true
    }
    @ObservationIgnored private var terminalReleases: [String: Task<Bool, Never>] = [:]
    @discardableResult func releaseTerminal(_ member: Member, expectedLeaseID: String? = nil) async -> Bool {
        if let expectedLeaseID, terminalLeases[member.id]?.leaseId != expectedLeaseID { return true }
        if let pending = terminalReleases[member.id] { return await pending.value }
        guard let releasingLeaseID = terminalLeases[member.id]?.leaseId else { return true }
        #if os(iOS)
        let background = TerminalReleaseBackgroundTask()
        #endif
        let task = Task {
            #if os(iOS)
            defer { background.end() }
            #endif
            guard self.terminalLeases[member.id]?.leaseId == releasingLeaseID else { return true }
            return await self.performTerminalRelease(member)
        }
        terminalReleases[member.id] = task
        let result = await task.value
        terminalReleases.removeValue(forKey: member.id)
        return result
    }
    private func performTerminalRelease(_ member: Member) async -> Bool {
        if strictWriteContract {
            let success = await terminalOperation(member, action: .release)
            if !success, terminalLeases[member.id] != nil {
                errorMessage = "\(member.name)의 조작권을 놓지 못했습니다. 결과 확인 중이며 서버의 lease가 유지될 수 있습니다."
            }
            return success || terminalLeases[member.id] == nil
        }
        guard let lease = terminalLeases[member.id]?.leaseId else { return false }
        let outcome: (value: TerminalLease?, error: Error?) = await perform("terminal:\(member.id)", refreshAfter: false) { api in
            try await api.terminalControl(memberID: member.id, request: TerminalControlRequest(action: "release", leaseId: lease))
        }
        if outcome.value != nil || Self.leaseGone(outcome.error) {
            terminalLeases.removeValue(forKey: member.id)
            // The server already holds no lease of ours (expired or released elsewhere): that is the state asked for.
            if let error = outcome.error as? APIError, error.message.contains("A matching active terminal control lease is required") {
                errorMessage = nil
                return true
            }
            return outcome.value != nil
        }
        // Not released: the server keeps the lease (up to 5 min) and holds automatic delivery. Keep it so the UI
        // still shows manual control and the release can be retried; say so where the strip shows it after the sheet closes.
        let reason = outcome.error?.localizedDescription
            ?? (!canWrite ? "서버에 연결되지 않음" : pendingActions.contains("terminal:\(member.id)") ? "다른 터미널 요청을 처리하는 중" : nil)
        errorMessage = "\(member.name)의 조작권을 놓지 못했습니다. 서버가 최대 5분 뒤 풀 때까지 자동 전달이 멈춰 있습니다. 조작을 다시 끝내 주세요." + (reason.map { " (\($0))" } ?? "")
        return false
    }
    @discardableResult func terminalInput(_ member: Member, text: String) async -> Bool {
        if strictWriteContract { return await terminalOperation(member, action: .input, text: text) }
        return await terminalControl(member, action: "input", text: text)
    }
    @discardableResult func terminalKey(_ member: Member, key: String) async -> Bool {
        guard ["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].contains(key) else { errorMessage = "지원하지 않는 키입니다."; return false }
        if strictWriteContract { return await terminalOperation(member, action: .key, key: TerminalKey(rawValue: key)) }
        return await terminalControl(member, action: "key", key: key)
    }
    private func terminalControl(_ member: Member, action: String, text: String? = nil, key: String? = nil) async -> Bool {
        guard let current = terminalLeases[member.id], let lease = current.leaseId else { errorMessage = "직접 조작을 시작한 뒤에 입력하세요."; return false }
        if let expiresAt = current.expiresAt, expiresAt <= Date().timeIntervalSince1970 * 1000 {
            // Keep the id: a new claim passes it and renews the lease if the server extended it after a lost reply.
            errorMessage = "직접 조작 시간이 끝났습니다. 다시 시작하세요."
            return false
        }
        if let text, text.utf8.count > 131072 { errorMessage = "터미널 입력은 128KB까지입니다."; return false }
        let outcome: (value: TerminalLease?, error: Error?) = await perform("terminal:\(member.id)", refreshAfter: false) { api in
            try await api.terminalControl(memberID: member.id, request: TerminalControlRequest(action: action, leaseId: lease, text: text, key: key))
        }
        guard let result = outcome.value else {
            // Only the server's word ends the lease. A timeout or dropped reply leaves it held on the server
            // (input may even have been typed), so forgetting it would hide manual control and lock out a re-claim.
            if Self.leaseGone(outcome.error) { terminalLeases.removeValue(forKey: member.id) }
            return false
        }
        // Some servers only include lease metadata on claim; retain the existing lease after input.
        if result.leaseId != nil { terminalLeases[member.id] = result }
        return true
    }
    /// The server answered that this device's lease is not (or no longer) the active one.
    private static func leaseGone(_ error: Error?) -> Bool {
        guard let error = error as? APIError else { return false }
        if error.status == 404 { return true }
        guard error.status == 409 else { return false }
        return ["A matching active terminal control lease is required", "Another terminal control lease is active",
                "Terminal has finished", "No core terminal for member", "조작권이 만료되었거나 바뀌었습니다"].contains { error.message.contains($0) }
    }

    private func releaseAllTerminals() {
        // Strict release is journaled and explicit. Dropping a connection must never replay an unknown input.
        guard !strictWriteContract, let api else { terminalLeases.removeAll(); return }
        let leases = terminalLeases
        terminalLeases.removeAll()
        Task {
            for (memberID, lease) in leases {
                guard let id = lease.leaseId else { continue }
                _ = try? await api.terminalControl(memberID: memberID, request: TerminalControlRequest(action: "release", leaseId: id))
            }
        }
    }

    private func terminalOperation(_ member: Member, action: TerminalAction, text: String? = nil, key: TerminalKey? = nil, claimID: String? = nil) async -> Bool {
        guard canWrite, let submissions, let version = writeRevisions?.members?[member.id],
              !pendingActions.contains("terminal:\(member.id)") else { return false }
        if let text, text.utf8.count > 131072 { errorMessage = "터미널 입력은 128KB까지입니다."; return false }
        let epoch = generation
        if let text {
            do { try submissions.setTerminalInput(text, namespace: writeNamespace, memberID: member.id) }
            catch { handle(error); return false }
        }
        if let previous = journal.operations.values.first(where: {
            $0.namespace == writeNamespace && $0.memberID == member.id && $0.kind == .terminalControl
                && ($0.status == .pending || $0.status == .unknown)
        }) {
            await reconcileOperation(previous)
            guard epoch == generation else { return false }
            // A claim has no physical input. After an explicit retry and a missing receipt,
            // reuse both durable IDs so a lost first claim can recover the same holder.
            if action == .claim, previous.action == .claim, absentOperations.contains(previous.id),
               claimID == nil || submissions.terminalAttempt(id: previous.id)?.claimID == claimID,
               let attempt = submissions.terminalAttempt(id: previous.id) {
                let result = await perform("terminal:\(member.id)", refreshAfter: false, deferRefusalToReceipt: true) { api in
                    try await api.terminalControl(memberID: member.id, request: attempt.request)
                }
                guard epoch == generation else { return false }
                if let receipt = result.value {
                    do { try applyReceipt(receipt, tracked: previous) } catch { handle(error) }
                } else {
                    await recordOperationFailure(previous, error: result.error)
                }
                return operationResults[previous.id]?.status == .applied
            }
            // A repeated click observes the original input; it never becomes another physical write.
            if previous.action == action, claimID == nil || submissions.terminalAttempt(id: previous.id)?.claimID == claimID {
                let sent = submissions.terminalAttempt(id: previous.id)
                return operationResults[previous.id]?.status == .applied && sent?.input?.text == text && sent?.key == key
            }
            guard let status = operationResults[previous.id]?.status, status == .applied || status == .refused else {
                errorMessage = "직접 조작 결과 확인 중입니다. 미확인 입력을 다시 보내지 않습니다."; return false
            }
        }
        if action == .claim {
            guard await recoverCancelledTerminalClaims(memberID: member.id) else { return false }
        }
        if action == .input || action == .key || action == .release {
            guard let lease = terminalLeases[member.id], lease.leaseId != nil else {
                errorMessage = "직접 조작을 시작한 뒤에 입력하세요."; return false
            }
            if action != .release, let expires = lease.expiresAt, expires <= Date().timeIntervalSince1970 * 1000 {
                errorMessage = "직접 조작 시간이 끝났습니다. 다시 시작하세요."; return false
            }
        }
        do {
            let attempt = try submissions.prepareTerminal(namespace: writeNamespace, memberID: member.id,
                                                         sessionGeneration: version.sessionGeneration, action: action, key: key, claimID: claimID)
            let tracked = TrackedOperation(id: attempt.id, namespace: writeNamespace, memberID: member.id,
                                           kind: .terminalControl, sessionGeneration: version.sessionGeneration,
                                           order: (journal.operations.values.map(\.order).max() ?? -1) + 1, action: action)
            try saveJournal { $0.operations[tracked.id] = tracked }
            let result = await perform("terminal:\(member.id)", refreshAfter: false, deferRefusalToReceipt: true) { api in
                try await api.terminalControl(memberID: member.id, request: submissions.beginTerminal(id: attempt.id))
            }
            guard epoch == generation else { return false }
            if let receipt = result.value { try applyReceipt(receipt, tracked: tracked) }
            else {
                await recordOperationFailure(tracked, error: result.error)
                if journal.operations[tracked.id]?.status != .refused { await reconcileOperation(tracked) }
            }
            if operationResults[tracked.id]?.status == .applied { return true }
            if action == .release, let receipt = operationResults[tracked.id], receipt.status == .refused,
               receipt.error == "조작권이 만료되었거나 바뀌었습니다" {
                terminalLeases.removeValue(forKey: member.id); errorMessage = nil
                return true
            }
            if Self.leaseGone(result.error) { terminalLeases.removeValue(forKey: member.id) }
        } catch { if epoch == generation { handle(error) } }
        return false
    }

    /// Reconcile without replaying physical input. A cancelled sheet claim is released after its receipt is recovered.
    func recoverWrites() async {
        guard canWrite, !recoveryInFlight else { return }
        recoveryInFlight = true
        defer { recoveryInFlight = false }
        let epoch = generation, namespace = writeNamespace
        for operation in journal.deliveryRecoveries?.values ?? Dictionary<String, PendingDeliveryRecovery>().values
            where operation.namespace == namespace && operation.projectID == selectedProjectID && operation.result == nil && !operation.refused {
            deliveryChecking.insert(operation.deliveryID)
            await loadDeliveryNotices(memberID: operation.memberID)
            guard epoch == generation, canWrite else { return }
        }
        for operation in journal.unassignedRecoveries?.values ?? Dictionary<String, PendingUnassignedRecovery>().values
            where operation.namespace == namespace && operation.projectID == selectedProjectID && operation.result == nil && !operation.refused {
            deliveryChecking.insert("message:\(operation.messageID)")
            await loadUnassignedDeliveries()
            guard epoch == generation, canWrite else { return }
        }
        guard strictWriteContract, let submissions else { return }
        for attempt in submissions.messages(namespace: namespace) where attempt.status == .checking || attempt.status == .accepted || attempt.status == .notAccepted {
            guard !isSending(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID) else { continue }
            _ = await reconcileMessage(attempt.id)
            guard epoch == generation, canWrite else { return }
        }
        do {
            var pruned = journal
            if pruned.pruneTerminalHistory() { try saveJournal { $0 = pruned } }
            else { try submissions.pruneTerminalHistory(keeping: Set(journal.operations.keys)) }
        } catch { handle(error); return }
        let operations = journal.operations.values.sorted(by: { $0.order < $1.order })
        // Only the latest applied terminal receipt can describe the current lease.
        let latestApplied = Dictionary(grouping: operations.filter { $0.namespace == namespace && $0.kind == .terminalControl && $0.status == .applied }, by: \.memberID)
            .compactMapValues { $0.last?.id }
        // Restore known checkpoints before observing older unresolved claims.
        for operation in operations where operation.namespace == namespace && latestApplied[operation.memberID] == operation.id {
            guard writeRevisions?.members?[operation.memberID]?.sessionGeneration == operation.sessionGeneration,
                  operation.order > (leaseReceiptOrder[operation.memberID] ?? -1) else { continue }
            if operation.action == .release || operation.leaseEnded == true {
                leaseReceiptOrder[operation.memberID] = operation.order
                terminalLeases.removeValue(forKey: operation.memberID)
            } else if let receipt = operation.receipt {
                do { try applyReceipt(receipt, tracked: operation) } catch { handle(error) }
            } else {
                // Older journals have no cached receipt. Fetch once to restore the lease.
                await reconcileOperation(operation)
            }
            guard epoch == generation, canWrite else { return }
        }
        for operation in operations where operation.namespace == namespace && (operation.status == .unknown || operation.status == .pending) {
            await reconcileOperation(operation)
            guard epoch == generation, canWrite else { return }
        }
        // Retry unfinished cleanup on every recovery, even when leaseReceiptOrder already consumed the claim.
        _ = await recoverCancelledTerminalClaims()
    }

    private func reconcileOperation(_ tracked: TrackedOperation) async {
        guard let api, canWrite, tracked.namespace == writeNamespace else { return }
        let epoch = generation
        do {
            let receipt = try await api.operation(id: tracked.id)
            guard epoch == generation else { return }
            absentOperations.remove(tracked.id)
            try applyReceipt(receipt, tracked: tracked)
        } catch {
            guard epoch == generation else { return }
            if (error as? APIError)?.status == 404 { absentOperations.insert(tracked.id) }
            if (error as? APIError)?.status == 401 { handle(error) }
            else if tracked.status == .unknown || tracked.status == .pending {
                errorMessage = "작업 결과 확인 중입니다. 미확인 작업은 재실행하지 않습니다."
            }
        }
    }

    private func applyReceipt(_ receipt: OperationReceipt, tracked: TrackedOperation) throws {
        guard receipt.operationId == tracked.id, receipt.kind == tracked.kind, receipt.memberId == tracked.memberID else {
            throw SubmissionError.mismatchedResult
        }
        guard let previousStatus = journal.operations[tracked.id]?.status else { return }
        if (previousStatus == .applied || previousStatus == .refused), receipt.status != previousStatus { return }
        if tracked.kind == .terminalControl {
            guard let submissions else { throw SubmissionError.invalidTransition }
            try submissions.applyTerminalReceipt(receipt)
            let latestAppliedOrder = journal.operations.values.filter {
                $0.namespace == tracked.namespace && $0.memberID == tracked.memberID && $0.kind == .terminalControl &&
                    $0.sessionGeneration == tracked.sessionGeneration && $0.status == .applied
            }.map(\.order).max() ?? -1
            if receipt.status == .applied, case .terminalControl(let result) = receipt.result,
               writeRevisions?.members?[tracked.memberID]?.sessionGeneration == result.sessionGeneration,
               tracked.order >= max(latestAppliedOrder, leaseReceiptOrder[tracked.memberID] ?? -1) {
                leaseReceiptOrder[tracked.memberID] = tracked.order
                if tracked.action == .release || journal.operations[tracked.id]?.leaseEnded == true {
                    terminalLeases.removeValue(forKey: tracked.memberID)
                }
                else if let lease = result.leaseId {
                    terminalLeases[tracked.memberID] = TerminalLease(leaseId: lease, expiresAt: result.expiresAt)
                }
            }
        } else if receipt.status == .applied {
            guard case .freshSession(let result) = receipt.result, result.member.id == tracked.memberID,
                  result.sessionGeneration > tracked.sessionGeneration else { throw SubmissionError.mismatchedResult }
        }
        var endedLeaseCheckpointID: String?
        if tracked.action == .release, receipt.status == .refused,
           let error = receipt.error, Self.leaseGone(APIError(status: 409, message: error)),
           writeRevisions?.members?[tracked.memberID]?.sessionGeneration == tracked.sessionGeneration,
           tracked.order >= (leaseReceiptOrder[tracked.memberID] ?? -1) {
            // The server definitively says this incarnation is gone, rather than temporarily busy.
            leaseReceiptOrder[tracked.memberID] = tracked.order
            terminalLeases.removeValue(forKey: tracked.memberID)
            endedLeaseCheckpointID = journal.operations.values.filter {
                $0.namespace == tracked.namespace && $0.memberID == tracked.memberID && $0.kind == .terminalControl &&
                    $0.sessionGeneration == tracked.sessionGeneration && $0.status == .applied && $0.order < tracked.order
            }.max { $0.order < $1.order }?.id
        }
        try saveJournal {
            $0.operations[tracked.id]?.status = receipt.status
            if let endedLeaseCheckpointID { $0.operations[endedLeaseCheckpointID]?.leaseEnded = true }
            if receipt.status == .applied { $0.operations[tracked.id]?.receipt = receipt }
        }
        operationResults[tracked.id] = receipt
        if receipt.status == .unknown || receipt.status == .pending {
            errorMessage = "작업 결과 확인 중입니다. 미확인 작업은 재실행하지 않습니다."
        } else if receipt.status == .refused, previousStatus != .refused {
            if tracked.kind == .terminalControl && terminalRefusalIsLocal(memberID: tracked.memberID, error: receipt.error) {
                terminalWindowNotices[tracked.memberID] = receipt.error
            } else { errorMessage = receipt.error ?? "서버가 작업을 거부했습니다." }
        }
    }

    private func recordOperationFailure(_ tracked: TrackedOperation, error: Error?) async {
        if journal.operations[tracked.id]?.status == .applied { return }
        let status: OperationStatus = Self.definiteRefusal(error) ? .refused : .unknown
        let receipt = OperationReceipt(operationId: tracked.id, kind: tracked.kind, memberId: tracked.memberID,
                                       status: status, code: (error as? APIError)?.code, error: error?.localizedDescription)
        do {
            try applyReceipt(receipt, tracked: tracked)
            // Refresh conflicts only after the durable refusal, so recovery cannot query this finished write.
            if status == .refused, (error as? APIError)?.status == 409,
               error?.localizedDescription.contains("No core terminal for member") != true { await refresh() }
        } catch { handle(error) }
    }

    /// All write revisions use the same atomic snapshot as the visible domain data.
    private func refreshWriteContext() async {
        await discoverCapabilities()
        guard strictWriteContract else { return }
        await enqueueRefresh(.snapshot, immediate: true, allowPaused: true)
    }

    private func applyWriteContext(_ snapshot: SyncSnapshot) throws {
        if writeRevisions != snapshot.revisions { writeRevisions = snapshot.revisions }
        if reviewedSettings != snapshot.bootstrap.settings { reviewedSettings = snapshot.bootstrap.settings }
        let members = (snapshot.state?.members ?? []).reduce(into: [:]) { $0[$1.id] = $1 }
        if reviewedMembers != members { reviewedMembers = members }
        let todos = (snapshot.state?.todos ?? []).reduce(into: [:]) { $0[$1.id] = $1 }
        if reviewedTodos != todos { reviewedTodos = todos }
        if settingsEdit == nil, let revision = snapshot.revisions?.settings {
            settingsEdit = SettingsEdit(base: snapshot.bootstrap.settings, draft: snapshot.bootstrap.settings, revision: revision)
        }
        for pending in Array(journal.todos.values) where pending.namespace == writeNamespace {
            guard let revision = snapshot.revisions?.todos?[pending.id], let todo = reviewedTodos[pending.id] else { continue }
            if revision > pending.revision {
                try saveJournal { $0.todos.removeValue(forKey: Self.scoped(pending.namespace, pending.id)) }
                todoWrites[pending.id] = (todo.done == pending.done && (pending.dropped != true || todo.outcome == "dropped")) ? .confirmedCurrent : .conflict
            } else { todoWrites[pending.id] = .checking }
        }
    }

    // MARK: Conversation history (independent of /state's recent-message window)

    @discardableResult
    func activateHistory(ownerID: UUID = UUID(), targetMemberID: String? = nil) async -> UUID {
        let key = historyKey(targetMemberID: targetMemberID)
        historyOwners.removeAll { $0.id == ownerID }
        historyOwners.append((ownerID, key, targetMemberID))
        historyVisible = true; historyTarget = targetMemberID
        guard let key else { return ownerID }
        if histories.activeKey != key { cancelHistoryLoad() }
        histories.activate(key)
        if let restoration = historyRestoration, restoration.key == key {
            await restoration.task.value
        } else {
            await loadActivatedHistory(key)
        }
        return ownerID
    }

    private func historyKey(targetMemberID: String?) -> ChatHistoryKey? {
        guard !isDemo, let projectID = selectedProjectID, state != nil else { return nil }
        return ChatHistoryKey(namespace: writeNamespace, connectionGeneration: generation, projectID: projectID,
                              scope: ChatHistoryKey.normalizedScope(targetMemberID: targetMemberID, members: members), archived: isArchive)
    }

    private func loadActivatedHistory(_ key: ChatHistoryKey) async {
        // A fallback task may start after its owner has disappeared or switched scope.
        guard !Task.isCancelled, historyVisible, histories.activeKey == key,
              historyOwners.contains(where: { $0.key == key }) else { return }
        await loadHistory(history?.initialized == true ? .latest : .initial)
        // One recovery attempt per activation, only for an idle, silent initial load.
        // Any surviving screen for this key can finish the shared load.
        if !Task.isCancelled, historyVisible, historyOwners.contains(where: { $0.key == key }), histories.activeKey == key,
           let history, !history.initialized, history.loading == nil, history.error == nil {
            await loadHistory(.initial)
            if historyVisible, historyOwners.contains(where: { $0.key == key }), histories.activeKey == key,
               foreground, connectionStatus == .connected, key.archived || pagingSupport != .unsupported {
                histories.finishInitialLoadIfIdle(for: key)
            }
        }
    }

    func deactivateHistory(ownerID: UUID) {
        guard let index = historyOwners.firstIndex(where: { $0.id == ownerID }) else { return }
        historyOwners.remove(at: index)
        guard let owner = historyOwners.last else {
            historyVisible = false; historyTarget = nil
            cancelHistoryLoad()
            return
        }
        historyTarget = owner.targetMemberID
        // Membership may have changed since this surviving screen last activated.
        let key = historyKey(targetMemberID: owner.targetMemberID)
        historyOwners[historyOwners.count - 1].key = key
        guard let key, histories.activeKey != key else { return }
        cancelHistoryLoad()
        histories.activate(key)
        let id = UUID()
        let task = Task { [weak self] in
            guard let self, historyRestoration?.id == id else { return }
            await loadActivatedHistory(key)
            if historyRestoration?.id == id { historyRestoration = nil }
        }
        // Reserve the catch-up before yielding, so refresh/activation joins even before HTTP starts.
        historyRestoration = (key, id, task)
    }
    func loadOlderMessages() async { await loadHistory(.older) }
    func refreshHistory() async {
        if let restoration = historyRestoration, restoration.key == histories.activeKey {
            await restoration.task.value
            return
        }
        guard let history else { return }
        // A disconnected interval stays staged until explicit continuation, never replaced by /state.
        guard !history.isBridging, !history.storeChanged else { return }
        await loadHistory(history.initialized ? .latest : .initial)
    }
    func continueHistoryBridge() async { await loadHistory(.bridge) }
    func restartHistoryFromLatest() async {
        guard let key = histories.activeKey else { return }
        cancelHistoryLoad()
        histories.invalidate(projectID: key.projectID)
        histories.activate(key)
        await loadHistory(.initial)
    }
    func setHistoryReadingPosition(_ anchor: ChatHistoryAnchor?, pinned: Bool) {
        guard let key = histories.activeKey else { return }
        histories.setReadingPosition(anchor, pinned: pinned, for: key)
    }
    /// Use for POST responses and individual realtime message events, never a stale /state batch.
    func receiveHistoryMessage(_ message: Message) {
        let message = mergingMessageDelivery(message)
        if let attempt = submissions?.messageAttempt(id: message.id), attempt.namespace == writeNamespace,
           attempt.projectID == message.projectId, message.mine, attempt.targetMemberID == message.targetMemberId {
            do { try submissions?.acceptMessage(id: message.id, message: message) }
            catch { handle(error) }
        }
        histories.receive(message, namespace: writeNamespace, connectionGeneration: generation)
        if state?.project.id == message.projectId,
           let index = state?.messages.firstIndex(where: { $0.id.utf8.elementsEqual(message.id.utf8) }) {
            state?.messages[index] = message
        }
        for index in notificationMessages.indices where notificationMessages[index].id.utf8.elementsEqual(message.id.utf8)
            && notificationMessages[index].projectId.utf8.elementsEqual(message.projectId.utf8) {
            notificationMessages[index] = message
        }
    }
    private func mergingMessageDelivery(_ message: Message) -> Message {
        let id = Data(message.id.utf8)
        let attempt = submissions?.messageAttempt(id: message.id)
        let accepted = attempt?.namespace == writeNamespace ? attempt?.message : nil
        let current = state?.messages.first { $0.id.utf8.elementsEqual(message.id.utf8) }
        let merged = message.mergingDelivery(from: accepted).mergingDelivery(from: current)
            .mergingDelivery(from: messageDeliveryUpdates[id])
        messageDeliveryUpdates[id] = merged
        return merged
    }
    private func mergingRecentMessageDelivery(_ snapshot: ProjectState?) -> ProjectState? {
        guard var snapshot else { return nil }
        snapshot.messages = snapshot.messages.map { mergingMessageDelivery($0) }
        return snapshot
    }
    private func cancelHistoryLoad() {
        // Invalidate queued restoration without waiting for its cancelled HTTP request.
        historyRestoration = nil
        guard let flight = historyFlight else { return }
        historyFlight = nil
        flight.task.cancel()
        histories.cancelLoad(for: flight.key)
        // A cancelled transport may still be blocked. Never make the next scope await it.
        // Cache cancellation/range tokens reject its late completion.
    }
    private func loadHistory(_ kind: ChatHistoryLoad) async {
        guard !isDemo, foreground, historyVisible, connectionStatus == .connected, let api,
              let key = histories.activeKey, key.projectID == selectedProjectID, key.archived == isArchive,
              key.connectionGeneration == generation, key.archived || pagingSupport != .unsupported else { return }
        while let flight = historyFlight, flight.key == key {
            await flight.task.value
            guard foreground, historyVisible, historyOwners.contains(where: { $0.key == key }), histories.activeKey == key,
                  key.connectionGeneration == generation else { return }
            // Another waiter may already have replaced the cancelled flight. Join it.
            if let current = historyFlight, current.id != flight.id { continue }
            if !flight.task.isCancelled, kind != .latest || flight.revision == historyInvalidationRevision { return }
            if historyFlight?.id == flight.id { historyFlight = nil }
        }
        let id = UUID(), projectEpoch = projectGeneration
        let failure = HistoryRequestFailure()
        let service = AppHistoryService(api: api, failure: failure)
        let task = Task { [weak self] in
            guard let self else { return }
            await histories.load(kind, for: key, using: service) { [weak self] message in
                guard let self, generation == key.connectionGeneration else { return message }
                return mergingMessageDelivery(message)
            }
            guard !Task.isCancelled, generation == key.connectionGeneration, projectGeneration == projectEpoch,
                  histories.activeKey == key else { return }
            if let error = await failure.error {
                if (error as? APIError)?.status == 401 { handle(error); return }
                // Only page 404 + a successful active /state proves an old server.
                if (error as? APIError)?.status == 404, !key.archived {
                    do {
                        let snapshot: ProjectState = try await api.request("/api/projects/\(APIClient.segment(key.projectID))/state")
                        guard !Task.isCancelled, generation == key.connectionGeneration, projectGeneration == projectEpoch,
                              histories.activeKey == key, snapshot.project.id.utf8.elementsEqual(key.projectID.utf8), !snapshot.project.archived else { return }
                        pagingSupport = .unsupported
                    } catch {
                        guard !Task.isCancelled, generation == key.connectionGeneration, projectGeneration == projectEpoch else { return }
                        if (error as? APIError)?.status == 401 { handle(error) }
                    }
                }
            } else if history?.initialized == true, !key.archived { pagingSupport = .supported }
        }
        historyFlight = (key, id, historyInvalidationRevision, task)
        await task.value
        if historyFlight?.id == id { historyFlight = nil }
        if !task.isCancelled, foreground, historyVisible, generation == key.connectionGeneration, projectGeneration == projectEpoch,
           histories.activeKey == key, (await failure.error as? APIError)?.code == "MESSAGE_SCOPE_CHANGED" {
            do {
                let snapshot: ProjectState = try await api.request("/api/projects/\(APIClient.segment(key.projectID))/state")
                guard foreground, historyVisible, generation == key.connectionGeneration, projectGeneration == projectEpoch, histories.activeKey == key,
                      snapshot.project.id.utf8.elementsEqual(key.projectID.utf8), !snapshot.project.archived else { return }
                let scope = ChatHistoryKey.normalizedScope(targetMemberID: historyTarget, members: snapshot.members)
                state = mergingRecentMessageDelivery(snapshot)
                if ChatHistoryKey.scopeBytes(scope) != ChatHistoryKey.scopeBytes(key.scope) {
                    if let owner = historyOwners.last {
                        await activateHistory(ownerID: owner.id, targetMemberID: owner.targetMemberID)
                    }
                }
            } catch {
                if generation == key.connectionGeneration, (error as? APIError)?.status == 401 { handle(error) }
            }
        }
    }

    // MARK: Delivery notices

    func loadUnassignedDeliveries() async {
        guard !isDemo, !isArchive, connectionStatus == .connected, let api, let projectID = selectedProjectID,
              deliveryFlights[""] == nil else { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration, token = UUID()
        deliveryFlights[""] = token; deliveryErrors[""] = nil
        defer { if deliveryFlights[""] == token { deliveryFlights[""] = nil } }
        do {
            let notices = try await api.unassignedDeliveryNotices(projectID: projectID)
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration,
                  phase == foregroundGeneration, deliveryFlights[""] == token else { return }
            guard notices.version == 2, (notices.unassignedItems ?? []).allSatisfy({
                $0.projectId == projectID && $0.memberId.isEmpty && $0.version == 0 && $0.id == "message:\($0.messageId)"
            }) else { throw SubmissionError.mismatchedResult }
            state?.deliveryNotices = notices
        } catch {
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration,
                  phase == foregroundGeneration, deliveryFlights[""] == token else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            deliveryErrors[""] = error.localizedDescription
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    @discardableResult func sendUnassignedToConductor(messageID: String) async -> Bool {
        await recoverUnassignedMessage(messageID: messageID, action: .sendToConductor)
    }
    @discardableResult func dismissUndelivered(messageID: String) async -> Bool {
        await recoverUnassignedMessage(messageID: messageID, action: .dismiss)
    }
    private func recoverUnassignedMessage(messageID: String, action: UnassignedRecoveryAction) async -> Bool {
        guard canWrite, let api, let projectID = selectedProjectID else { return false }
        let epoch = generation, projectEpoch = projectGeneration, namespace = writeNamespace
        let scope = Self.scoped(namespace, messageID), key = "unassigned:\(messageID)"
        guard !pendingActions.contains(key) else { return false }
        let previous = journal.unassignedRecoveries?[scope]
        let unresolved = previous.flatMap { $0.result == nil && !$0.refused ? $0 : nil }
        guard unresolved == nil || unresolved?.action == action else {
            errorMessage = "이전 전달 작업의 결과를 먼저 확인해 주세요."; return false
        }
        if unresolved == nil && !unassignedDeliveries.contains(where: { $0.messageId == messageID }) {
            await loadUnassignedDeliveries()
        }
        guard epoch == generation, projectEpoch == projectGeneration, canWrite, !pendingActions.contains(key) else { return false }
        let item = unassignedDeliveries.first { $0.messageId == messageID }
        guard unresolved != nil || (item?.version == 0 && item?.allowedActions.contains(action) == true) else { return false }
        var tracked = unresolved ?? PendingUnassignedRecovery(id: UUID().uuidString, namespace: namespace,
            projectID: projectID, messageID: messageID, version: item!.version, action: action)
        do {
            try saveJournal {
                if $0.unassignedRecoveries == nil { $0.unassignedRecoveries = [:] }
                $0.unassignedRecoveries?[scope] = tracked
            }
        } catch { handle(error); return false }
        pendingActions.insert(key); deliveryChecking.insert("message:\(messageID)")
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            let result = try await api.recoverUnassignedMessage(messageID: messageID, request: UnassignedRecoveryRequest(
                operationId: tracked.id, expectedVersion: tracked.version, action: tracked.action))
            guard epoch == generation else { return false }
            guard result.operationId == tracked.id, result.messageId == messageID, result.committedVersion > tracked.version,
                  result.outcome == (action == .dismiss ? "dismissed" : "send_scheduled"),
                  action == .dismiss ? result.deliveryId == nil : result.deliveryId?.isEmpty == false else { throw SubmissionError.mismatchedResult }
            tracked.result = result
            try saveJournal { $0.unassignedRecoveries?[scope] = tracked }
            guard projectEpoch == projectGeneration else { return false }
            deliveryChecking.remove("message:\(messageID)")
            deliveryFlights[""] = nil
            await refresh()
            guard epoch == generation, projectEpoch == projectGeneration else { return false }
            await loadUnassignedDeliveries()
            let message = try await api.message(id: messageID)
            guard epoch == generation, projectEpoch == projectGeneration else { return false }
            guard message.id == messageID, message.projectId == projectID else { throw SubmissionError.mismatchedResult }
            receiveHistoryMessage(message)
            return true
        } catch {
            guard epoch == generation else { return false }
            if tracked.result == nil && Self.definiteRefusal(error) {
                tracked.refused = true
                do { try saveJournal { $0.unassignedRecoveries?[scope] = tracked } }
                catch { handle(error) }
            }
            guard projectEpoch == projectGeneration else { return false }
            if tracked.refused || tracked.result != nil { deliveryChecking.remove("message:\(messageID)") }
            handle(error)
            deliveryFlights[""] = nil
            await refresh()
            guard epoch == generation, projectEpoch == projectGeneration else { return false }
            await loadUnassignedDeliveries()
            return tracked.result != nil
        }
    }

    func loadDeliveryNotices(memberID: String, older: Bool = false) async {
        guard !isDemo, !isArchive, connectionStatus == .connected, let api, let projectID = selectedProjectID,
              members.contains(where: { $0.id == memberID }) else { return }
        if deliveryFlights[memberID] != nil {
            if !older { deliveryRefreshPending.insert(memberID) }
            return
        }
        let previous = deliveryPages[memberID]
        if older && previous?.nextBefore == nil { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration, token = UUID()
        deliveryFlights[memberID] = token
        deliveryErrors[memberID] = nil
        defer {
            if deliveryFlights[memberID] == token {
                deliveryFlights[memberID] = nil
                if deliveryRefreshPending.remove(memberID) != nil {
                    Task { [weak self] in await self?.enqueueRefresh(.delivery) }
                }
            }
        }
        do {
            let page = try await api.deliveryNotices(memberID: memberID, before: older ? previous?.nextBefore : nil, limit: 50)
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration, deliveryFlights[memberID] == token else { return }
            guard page.memberId.utf8.elementsEqual(memberID.utf8), page.summary.memberId.utf8.elementsEqual(memberID.utf8),
                  page.items.allSatisfy({ $0.memberId?.utf8.elementsEqual(memberID.utf8) == true && $0.projectId?.utf8.elementsEqual(projectID.utf8) == true }),
                  page.items.count <= 50, page.nextBefore == nil || (!page.items.isEmpty && page.nextBefore != (older ? previous?.nextBefore : nil)) else {
                throw SubmissionError.mismatchedResult
            }
            var items = older ? previous?.items ?? [] : []
            for item in page.items {
                if let index = items.firstIndex(where: { $0.id.utf8.elementsEqual(item.id.utf8) }) { items[index] = item }
                else { items.append(item) }
            }
            deliveryPages[memberID] = DeliveryNoticePage(memberId: memberID, summary: page.summary, items: items, nextBefore: page.nextBefore)
        } catch {
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration, deliveryFlights[memberID] == token else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            deliveryErrors[memberID] = error.localizedDescription
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    /// A retry after a lost response reuses the durable operation and its original reviewed version.
    @discardableResult func recoverDelivery(_ item: DeliveryNoticeItem, action: DeliveryRecoveryAction,
                                            acceptDuplicateRisk: Bool = false) async -> Bool {
        guard canWrite, let api, let projectID = selectedProjectID, item.projectId == projectID,
              let memberID = item.memberId, members.contains(where: { $0.id == memberID }),
              let deliveryID = item.deliveryId, let version = item.version, version > 0,
              item.safeAllowedActions.contains(action), action != .unknown,
              action == .retryWithRisk ? acceptDuplicateRisk : !acceptDuplicateRisk else { return false }
        let key = "delivery:\(deliveryID)"
        guard !pendingActions.contains(key) else { return false }
        let epoch = generation, projectEpoch = projectGeneration, namespace = writeNamespace
        let previous = journal.deliveryRecoveries?[Self.scoped(namespace, deliveryID)]
        // Do not turn an unresolved operation into a different action/version.
        guard previous == nil || previous?.result != nil || previous?.refused == true || previous?.action == action else {
            errorMessage = "이전 전달 작업의 결과를 먼저 확인해 주세요."; return false
        }
        var tracked = previous.flatMap { $0.result == nil && !$0.refused ? $0 : nil }
            ?? PendingDeliveryRecovery(id: UUID().uuidString, namespace: namespace, projectID: projectID,
                                       memberID: memberID, deliveryID: deliveryID, version: version,
                                       action: action, acceptDuplicateRisk: acceptDuplicateRisk)
        do {
            try saveJournal {
                if $0.deliveryRecoveries == nil { $0.deliveryRecoveries = [:] }
                $0.deliveryRecoveries?[Self.scoped(namespace, deliveryID)] = tracked
            }
        } catch { handle(error); return false }
        pendingActions.insert(key); deliveryChecking.insert(deliveryID)
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            let result = try await api.recoverDelivery(id: deliveryID, request: DeliveryRecoveryRequest(
                operationId: tracked.id, expectedVersion: tracked.version, action: tracked.action,
                acceptDuplicateRisk: tracked.action == .retryWithRisk ? true : nil))
            guard epoch == generation else { return false }
            guard result.operationId == tracked.id, result.deliveryId == deliveryID, result.committedVersion > tracked.version,
                  (tracked.action == .recheck && result.outcome == .checkScheduled)
                    || (tracked.action == .retryWithRisk && result.outcome == .retryScheduled)
                    || (tracked.action == .stopRetry && result.outcome == .stopped) else { throw SubmissionError.mismatchedResult }
            tracked.result = result
            try saveJournal { $0.deliveryRecoveries?[Self.scoped(namespace, deliveryID)] = tracked }
            guard projectEpoch == projectGeneration else { return false }
            deliveryResults[tracked.id] = result
            deliveryChecking.remove(deliveryID)
            // 202 means scheduled, never "received". Re-read both aggregate and detail immediately.
            await refresh()
            guard epoch == generation, projectEpoch == projectGeneration else { return false }
            await loadDeliveryNotices(memberID: memberID)
            return true
        } catch {
            guard epoch == generation else { return false }
            if Self.definiteRefusal(error) {
                tracked.refused = true
                do { try saveJournal { $0.deliveryRecoveries?[Self.scoped(namespace, deliveryID)] = tracked } }
                catch { handle(error) }
            }
            guard projectEpoch == projectGeneration else { return false }
            if tracked.refused { deliveryChecking.remove(deliveryID) }
            handle(error)
            await refresh()
            guard epoch == generation, projectEpoch == projectGeneration else { return false }
            await loadDeliveryNotices(memberID: memberID)
            return false
        }
    }

    func loadArchivedProjects() async {
        guard !isDemo, foreground, let api, connectionStatus == .connected else { return }
        archiveObserved = true
        let epoch = generation, phase = foregroundGeneration, token = UUID()
        archiveLoad = token; archiveError = nil; isLoadingArchive = true
        defer { if epoch == generation, archiveLoad == token { isLoadingArchive = false } }
        do {
            let projects = try await api.archivedProjects()
            guard epoch == generation, phase == foregroundGeneration, foreground, archiveLoad == token else { return }
            guard projects.allSatisfy(\.archived) else { throw SubmissionError.mismatchedResult }
            archivedProjects = projects
        } catch {
            guard epoch == generation, phase == foregroundGeneration, foreground, archiveLoad == token else { return }
            archiveError = error.localizedDescription
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }
    @discardableResult func patchProject(id: String, request: PatchProjectRequest) async -> Bool {
        guard !isDemo, foreground, !isRevalidating, connectionStatus == .connected, let api else {
            errorMessage = "서버에 연결된 뒤에 프로젝트를 관리할 수 있습니다."; return false
        }
        let key = "project:\(id)", journalKey = Self.scoped(writeNamespace, id)
        guard !pendingActions.contains(key), journal.projectChanges?[journalKey] == nil else {
            errorMessage = "이전 프로젝트 변경 결과를 먼저 확인해 주세요."; return false
        }
        guard !(request.archived == true && (id == "hq" || projects.first { $0.id == id }?.isHq == true)) else {
            errorMessage = "본사는 보관할 수 없습니다."; return false
        }
        let epoch = generation
        let tracked = PendingProjectChange(namespace: writeNamespace, projectID: id, request: request)
        do { try saveJournal { if $0.projectChanges == nil { $0.projectChanges = [:] }; $0.projectChanges?[journalKey] = tracked } }
        catch { handle(error); return false }
        pendingActions.insert(key); projectResults[id] = .sending; errorMessage = nil
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            let project = try await api.patchProject(id: id, request: request)
            guard epoch == generation else { return false }
            guard project.id == id else { throw SubmissionError.mismatchedResult }
            try saveJournal { $0.projectChanges?.removeValue(forKey: journalKey) }
            projectResults[id] = .applied
            await applyManagedProject(project)
            guard epoch == generation else { return false }
            guard foreground else { return true }
            await refresh(); await loadArchivedProjects()
            return epoch == generation
        } catch {
            guard epoch == generation else { return false }
            let refused = Self.definiteRefusal(error)
            projectResults[id] = refused ? .refused : .checking
            if refused {
                do { try saveJournal { $0.projectChanges?.removeValue(forKey: journalKey) } }
                catch { handle(error) }
            }
            handle(error)
            if self.api != nil, foreground {
                await refresh(); await loadArchivedProjects()
                guard epoch == generation else { return false }
                if !refused { await recheckProject(id: id) }
                errorMessage = refused ? error.localizedDescription : "프로젝트 변경 결과를 확인해 주세요. 요청은 다시 보내지 않았습니다."
            }
            return false
        }
    }

    /// Reads only. Matching current metadata is observable; it is not an operation receipt.
    func recheckProject(id: String) async {
        guard foreground, let api, connectionStatus == .connected else { return }
        let epoch = generation, phase = foregroundGeneration, key = Self.scoped(writeNamespace, id)
        guard let tracked = journal.projectChanges?[key] else { return }
        do {
            let archived = try await api.archivedProjects()
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            let project: Project
            if let found = archived.first(where: { $0.id == id }) { project = found }
            else { project = try await (api.request("/api/projects/\(APIClient.segment(id))/state") as ProjectState).project }
            guard epoch == generation, phase == foregroundGeneration, foreground, journal.projectChanges?[key]?.id == tracked.id else { return }
            guard project.id == id else { throw SubmissionError.mismatchedResult }
            if tracked.matches(project) {
                try saveJournal { $0.projectChanges?.removeValue(forKey: key) }
                projectResults[id] = .current
                await applyManagedProject(project)
            } else { projectResults[id] = .checking }
        } catch {
            guard epoch == generation, journal.projectChanges?[key]?.id == tracked.id else { return }
            projectResults[id] = .checking
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    private func reconcileProjectChanges() async {
        let epoch = generation, phase = foregroundGeneration, namespace = writeNamespace
        for tracked in Array(journal.projectChanges?.values ?? Dictionary<String, PendingProjectChange>().values)
            where tracked.namespace == namespace && !pendingActions.contains("project:\(tracked.projectID)") {
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            projectResults[tracked.projectID] = .checking
            await recheckProject(id: tracked.projectID)
        }
    }

    private func applyManagedProject(_ project: Project) async {
        if let index = bootstrap?.projects.firstIndex(where: { $0.id == project.id }) {
            if project.archived { bootstrap?.projects.remove(at: index) }
            else { bootstrap?.projects[index].name = project.name; bootstrap?.projects[index].cwd = project.cwd }
        }
        if let index = archivedProjects.firstIndex(where: { $0.id == project.id }) {
            if project.archived { archivedProjects[index] = project } else { archivedProjects.remove(at: index) }
        } else if project.archived { archivedProjects.append(project) }
        guard selectedProjectID == project.id else { return }
        if project.archived && !isArchive {
            state = nil; histories.invalidate(projectID: project.id)
            for item in routers { item.value?.resetForProjectChange() }
            projectNotice = "프로젝트를 보관했습니다."
            if let next = projects.first(where: { $0.id == "hq" || $0.isHq }) ?? projects.first {
                if foreground { await selectProject(id: next.id) }
                else { selectedProjectID = next.id; isArchive = false; projectGeneration = UUID(); isRevalidating = true }
            } else { selectedProjectID = nil; projectGeneration = UUID() }
        } else if !project.archived && isArchive {
            if foreground { await selectProject(id: project.id) }
            else { state = nil; isArchive = false; projectGeneration = UUID(); isRevalidating = true }
        } else { state?.project = project }
    }

    @discardableResult func compactMember(_ member: Member) async -> Bool {
        guard canWrite, foreground, let api, let current = members.first(where: { $0.id == member.id }),
              current.projectId == selectedProjectID, current.origin != "manual", current.paneId != nil,
              !["asleep", "offline", "gone"].contains(current.status),
              (current.backend ?? bootstrap?.settings.backend) != "core" || (current.contextState != nil && current.sessionId != nil) else {
            errorMessage = "현재 세션은 문맥 압축을 지원하지 않거나 사용할 수 없습니다."; return false
        }
        let key = "member:\(member.id)", trackedKey = Self.scoped(writeNamespace, member.id)
        guard !pendingActions.contains(key), journal.contextRequests?[trackedKey] == nil else {
            errorMessage = "압축 결과 확인 중입니다. 다시 전송하지 않습니다."; return false
        }
        if let phase = current.contextState?.compaction?.phase, [.queued, .sending, .running, .uncertain, .unknown].contains(phase) { return false }
        let epoch = generation, projectEpoch = projectGeneration
        do {
            try saveJournal {
                if $0.contextRequests == nil { $0.contextRequests = [:] }
                $0.contextRequests?[trackedKey] = PendingContextRequest(namespace: writeNamespace, memberID: member.id,
                    sessionID: current.sessionId, previousCompactionID: current.contextState?.compaction?.id)
            }
        } catch { handle(error); return false }
        pendingActions.insert(key); contextChecking.insert(member.id)
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            let result: Member = try await api.request("/api/members/\(APIClient.segment(member.id))/compact", method: "POST", timeout: 150)
            guard epoch == generation else { return false }
            guard result.id == member.id, result.projectId == current.projectId else { throw SubmissionError.mismatchedResult }
            if (current.backend ?? bootstrap?.settings.backend) == "core", result.contextState?.compaction == nil {
                throw SubmissionError.mismatchedResult
            }
            if projectEpoch == projectGeneration, let index = state?.members.firstIndex(where: { $0.id == result.id }) { state?.members[index] = result }
            // A successful response is acceptance, not evidence that compaction finished.
            if result.contextState?.compaction == nil {
                try saveJournal { $0.contextRequests?.removeValue(forKey: trackedKey) }
                contextChecking.remove(member.id)
            }
            if foreground { await refresh() }
            return epoch == generation
        } catch {
            guard epoch == generation else { return false }
            if Self.definiteRefusal(error) {
                do { try saveJournal { $0.contextRequests?.removeValue(forKey: trackedKey) }; contextChecking.remove(member.id) }
                catch { handle(error) }
            }
            handle(error)
            if foreground { await refresh() }
            if contextChecking.contains(member.id) { errorMessage = "압축 결과 확인 중입니다. 다시 전송하지 않습니다." }
            return false
        }
    }

    private func reconcileContextChanges() {
        for (key, tracked) in journal.contextRequests ?? [:] where tracked.namespace == writeNamespace {
            guard let member = members.first(where: { $0.id == tracked.memberID }) else { continue }
            let compaction = member.contextState?.compaction
            if member.sessionId != tracked.sessionID || (compaction?.id != tracked.previousCompactionID
                && compaction?.phase.map { [.succeeded, .failed].contains($0) } == true) {
                do { try saveJournal { $0.contextRequests?.removeValue(forKey: key) }; contextChecking.remove(member.id) }
                catch { handle(error) }
            } else { contextChecking.insert(member.id) }
        }
    }

    /// Scene owners register their local Router; the AppStore and mailbox remain app-scoped.
    func registerRouter(_ router: Router) {
        routers.removeAll { $0.value == nil }
        if !routers.contains(where: { $0.value === router }) {
            routers.append(WeakRouter(router))
            router.destinationChanged = { [weak self] destination in self?.saveNavigation(destination: destination) }
            if bootstrap != nil, !isDemo {
                let saved = navigationDefaults?.dictionary(forKey: navigationKey)?["destination"] as? String
                if let saved = saved.flatMap(Destination.init(rawValue:)) { router.restoreDestination(saved) }
            }
        }
    }

    private func clearHostNavigation() {
        serverID = nil; pushConnectionError = nil; pendingNotification = nil; notificationNotice = nil
        leaveNotificationAnchor()
        for router in routers { router.value?.resetForConnectionChange() }
    }

    func leaveNotificationAnchor() {
        notificationMessages = []; notificationMessageID = nil; notificationScope = nil
    }

    private func beginPushLogout() {
        guard let pushNotifications, pushSettings.host != nil, pushLogoutTask == nil else {
            if pushNotifications == nil { pushSettings.setHost(nil) }
            return
        }
        // Keep the old client only for this revocation. Its persisted failure marker survives logout.
        pushLogoutTask = Task {
            await pushNotifications.revoke()
            pushNotifications.setHost(nil)
        }
    }

    /// Read-only discovery is independent of capabilities and never asks for OS permission.
    func refreshPushConnection() async {
        guard !isDemo, foreground, connectionStatus == .connected, let api, let credentials = connectedCredentials,
              let validated = try? ServerEndpoint(credentials.endpoint) else { return }
        let epoch = generation, phase = foregroundGeneration
        await pushLogoutTask?.value
        guard epoch == generation, phase == foregroundGeneration, foreground else { return }
        pushLogoutTask = nil
        do {
            let status = try await api.pushStatus()
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            guard status.serverId.utf8.count == 36, UUID(uuidString: status.serverId) != nil else { throw SubmissionError.mismatchedResult }
            pushConnectionError = status.supported ? nil : .unsupported
            let id = status.serverId.lowercased()
            if serverID != id || pushSettings.host == nil {
                if serverID != nil, serverID != id {
                    pendingNotification = nil; leaveNotificationAnchor()
                    for router in routers { router.value?.resetForConnectionChange() }
                }
                serverID = id
                let host = PushHostContext(serverID: id, endpoint: validated, service: api)
                if let pushNotifications { pushNotifications.setHost(host) } else { pushSettings.setHost(host) }
            }
            try saveJournal {
                if $0.serverEndpoints == nil { $0.serverEndpoints = [:] }
                $0.serverEndpoints?[id] = validated.url.absoluteString
            }
            await pushNotifications?.foreground()
        } catch {
            guard epoch == generation, phase == foregroundGeneration else { return }
            // Unsupported or unhealthy push is not a failure of the application connection.
            if (error as? APIError)?.status == 401 { handle(error) }
            else if let error = error as? APIError, [404, 501].contains(error.status) { pushConnectionError = .unsupported }
            else if error is SubmissionError || error is DecodingError { pushConnectionError = .invalidResponse }
            else { pushConnectionError = .requestFailed((error as? APIError)?.status ?? 0) }
        }
    }

    /// Called by an active scene when the app mailbox changes or its connection becomes ready.
    /// Taking the link before the first await is the multi-window consumption token.
    func processNotifications(router: Router, inbox: NotificationInbox? = nil) async {
        let inbox = inbox ?? .shared
        registerRouter(router)
        guard !isDemo, foreground, connectionStatus == .connected || connectionLost, let api, let serverID,
              !notificationFlight else { return }
        notificationFlight = true
        defer { notificationFlight = false }
        if let owner = pendingNotificationOwner, owner.router.value == nil || owner.router.value?.navigationRevision != owner.revision {
            pendingNotification = nil; pendingNotificationOwner = nil
        }
        if pendingNotification == nil { pendingNotification = inbox.consume(serverID: serverID) }
        guard let link = pendingNotification else {
            if notificationRefreshRevision != inbox.refreshRevision {
                notificationRefreshRevision = inbox.refreshRevision
                await enqueueRefresh(.all, immediate: true)
            }
            if let first = inbox.pending.first, first.serverID != serverID { notificationNotice = "이 알림의 호스트에 연결해 주세요." }
            return
        }
        guard link.serverID == serverID else { pendingNotification = nil; return }
        let opening = router.beginOpeningNotification(link.target)
        defer { router.finishOpeningNotification(opening) }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration
        let navigation = router.navigationRevision, reset = router.projectResetRevision
        pendingNotificationOwner = (WeakRouter(router), navigation)
        func valid() -> Bool {
            !Task.isCancelled && epoch == generation && phase == foregroundGeneration && foreground
                && self.serverID == serverID && router.navigationRevision == navigation
        }
        do {
            async let hintedContext = api.notificationContext(target: link.target)
            let target: PushTarget
            if let eventID = link.eventID {
                let result = try await api.pushTarget(eventID: eventID)
                guard valid(), projectEpoch == projectGeneration else { pendingNotification = nil; return }
                guard result.serverId.lowercased() == serverID, result.eventId.lowercased() == eventID else { throw SubmissionError.mismatchedResult }
                target = result.target
            } else { target = link.target }
            var route = NotificationRoute(target: target)
            let projectID: String?
            switch target {
            case .home: projectID = nil
            case .projectHome(let project): projectID = project
            case .inbox(let project, _), .team(let project, _), .chat(let project, _, _, _): projectID = project
            case .unknown: throw SubmissionError.mismatchedResult
            }
            let context: NotificationContext
            if target == link.target { context = try await hintedContext }
            else {
                _ = try? await hintedContext
                context = try await api.notificationContext(target: target)
            }
            guard valid(), projectEpoch == projectGeneration else { pendingNotification = nil; return }
            let snapshot = context.state
            if let projectID {
                guard snapshot?.project.id == projectID, snapshot?.project.archived == false else {
                    throw APIError(status: 404, message: "보관되었거나 없는 프로젝트입니다.")
                }
            }
            switch target {
            case .inbox(let project, let id):
                guard let decision = context.decision, decision.id == id, decision.projectId == project else { throw SubmissionError.mismatchedResult }
                if decision.status != "open" { route.notice = "이미 처리된 결재입니다." }
            case .team(let project, let id):
                guard snapshot?.members.contains(where: { $0.id == id && $0.projectId == project }) == true else {
                    throw APIError(status: 404, message: "직원을 찾을 수 없습니다.")
                }
            case .chat(let project, _, let id, _):
                if context.missingReport { route.notice = "보고를 찾을 수 없습니다." }
                else {
                    guard context.messages.allSatisfy({ $0.projectId == project }), let anchor = context.messages.first(where: { $0.id == id }) else {
                        throw SubmissionError.mismatchedResult
                    }
                    let targetID = anchor.targetMemberId ?? anchor.memberId
                    if case .member(let memberID) = ChatHistoryKey.normalizedScope(targetMemberID: targetID, members: snapshot?.members ?? []) {
                        route.chatTarget = memberID
                    }
                    route.chatMessageID = id
                }
            case .home, .projectHome, .unknown: break
            }
            guard valid(), projectEpoch == projectGeneration else { pendingNotification = nil; return }
            let changed = projectID != nil && (selectedProjectID != projectID || isArchive || state?.project.id != projectID)
            let selectedEpoch = changed ? UUID() : projectEpoch
            if changed, let projectID { await selectProject(id: projectID, archived: false, navigationToken: selectedEpoch) }
            guard valid(), selectedEpoch == projectGeneration,
                  projectID == nil || (selectedProjectID == projectID && !isArchive && state?.project.id == projectID && state?.project.archived == false) else {
                if !valid() { pendingNotification = nil }
                return
            }
            if case .chat = target, let id = route.chatMessageID {
                notificationScope = ChatHistoryKey.normalizedScope(targetMemberID: route.chatTarget, members: snapshot?.members ?? [])
                notificationMessages = context.messages.filter { message in
                    if case .member(let member) = notificationScope { return message.memberId == member || message.targetMemberId == member }
                    return true
                }.sorted(by: ChatHistory.ordered)
                notificationMessageID = id
            }
            guard valid(), selectedEpoch == projectGeneration else { pendingNotification = nil; return }
            pendingNotification = nil; notificationNotice = route.notice
            router.applyNotification(route, afterProjectChange: changed, resetRevision: reset)
        } catch {
            guard epoch == generation else { return }
            if !valid() || projectEpoch != projectGeneration { pendingNotification = nil; return }
            if error is SubmissionError || error is DecodingError {
                pendingNotification = nil; notificationNotice = "지원하지 않거나 올바르지 않은 알림 목적지입니다."
            } else if let error = error as? APIError, [400, 401, 403, 404, 410, 422, 501].contains(error.status) {
                pendingNotification = nil
                notificationNotice = error.status == 404 ? "알림의 항목이 없거나 프로젝트가 보관되었습니다." : "알림의 목적지를 열 수 없습니다."
                if error.status == 401 { inbox.discardPending(); handle(error) }
            } else {
                notificationNotice = "알림의 최신 상태를 확인하지 못했습니다. 연결 후 다시 확인합니다."
            }
        }
    }
    private func resetReadCollections() {
        messageDeliveryUpdates = [:]
        cancelHistoryLoad(); histories.removeAll(); historyVisible = false; historyOwners = []; historyTarget = nil
        historyFlight = nil
        pagingSupport = .unknown; isArchive = false; archivedProjects = []; archiveError = nil
        archiveLoad = UUID(); isLoadingArchive = false; archiveObserved = false
        projectResults = [:]; projectNotice = nil; contextChecking = []
        deliveryPages = [:]; deliveryErrors = [:]; deliveryResults = [:]; deliveryChecking = []; deliveryFlights = [:]; deliveryRefreshPending = []
        openActivityMembers = []; activityTokens = [:]; activityRevisions = [:]; activities = [:]; activityErrors = [:]
    }

    private func saveJournal(_ change: (inout AppWriteJournal) -> Void) throws {
        if let persistenceFailure { throw APIError(status: 0, message: persistenceFailure) }
        var next = journal
        change(&next)
        next.pruneTerminalHistory()
        try writeStorage.write(next)
        journal = next
        let kept = Set(next.operations.keys)
        operationResults = operationResults.filter { $0.value.kind != .terminalControl || kept.contains($0.key) }
        absentOperations.formIntersection(kept)
        try submissions?.pruneTerminalHistory(keeping: kept)
    }
    private static func scoped(_ namespace: String, _ id: String) -> String { "\(namespace.utf8.count):\(namespace)|\(id)" }
    private static func definiteRefusal(_ error: Error?) -> Bool {
        guard let error = error as? APIError else { return false }
        return [400, 401, 403, 404, 409, 422, 501].contains(error.status)
            && error.code != "OPERATION_UNKNOWN" && error.code != "RESULT_UNKNOWN"
    }
    private static func same<T: Encodable>(_ lhs: T, _ rhs: T) -> Bool {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(lhs)) == (try? encoder.encode(rhs))
    }
    private static func empty(_ patch: SettingsPatchRequest) -> Bool {
        (try? JSONEncoder().encode(patch)) == Data("{}".utf8)
    }
    private static func settingsPatch(base: Settings, draft: Settings) -> SettingsPatchRequest {
        var patch = SettingsPatchRequest()
        if base.permissionMode != draft.permissionMode { patch.permissionMode = draft.permissionMode }
        if base.maxConcurrentTurns != draft.maxConcurrentTurns { patch.maxConcurrentTurns = draft.maxConcurrentTurns }
        if base.compactAtPct != draft.compactAtPct { patch.compactAtPct = draft.compactAtPct }
        if base.contextWindowDefault != draft.contextWindowDefault { patch.contextWindowDefault = draft.contextWindowDefault }
        if base.contextWindows != draft.contextWindows { patch.contextWindows = draft.contextWindows }
        if base.maxAwakeWorkers != draft.maxAwakeWorkers { patch.maxAwakeWorkers = draft.maxAwakeWorkers }
        if base.notifyMac != draft.notifyMac { patch.notifyMac = draft.notifyMac }
        if base.boardTidyHours != draft.boardTidyHours { patch.boardTidyHours = draft.boardTidyHours }
        var ranks: [String: RankConfigPatch] = [:]
        for key in Set(base.ranks.keys).union(draft.ranks.keys) {
            let before = base.ranks[key], after = draft.ranks[key]
            var rank = RankConfigPatch()
            if before?.model != after?.model { rank.model = after?.model.map { .value($0) } ?? .null }
            if before?.effort != after?.effort { rank.effort = after?.effort.map { .value($0) } ?? .null }
            if rank.model != nil || rank.effort != nil { ranks[key] = rank }
        }
        if !ranks.isEmpty { patch.ranks = ranks }
        var codexRanks: [String: RankConfigPatch] = [:]
        for key in Set(base.codexRanks.keys).union(draft.codexRanks.keys) {
            let before = base.codexRanks[key], after = draft.codexRanks[key]
            var rank = RankConfigPatch()
            if before?.model != after?.model { rank.model = after?.model.map { .value($0) } ?? .null }
            if before?.effort != after?.effort { rank.effort = after?.effort.map { .value($0) } ?? .null }
            if rank.model != nil || rank.effort != nil { codexRanks[key] = rank }
        }
        if !codexRanks.isEmpty { patch.codexRanks = codexRanks }
        return patch
    }
}

struct SettingsEdit: Sendable {
    let base: Settings
    var draft: Settings
    let revision: Int
}
enum CardWriteStatus: String, Sendable { case accepted, conflict, unknown, refused, notSent }
enum TodoWriteState: String, Sendable { case sending, checking, confirmed, confirmedCurrent, conflict }
private struct TrackedOperation: Codable {
    let id: String
    let namespace: String
    let memberID: String
    let kind: OperationKind
    let sessionGeneration: Int
    let order: Int
    var action: TerminalAction? = nil
    var cancelledClaim: Bool? = nil
    var status: OperationStatus = .unknown
    var receipt: OperationReceipt? = nil // Optional for journals written before fix 11.
    var leaseEnded: Bool? = nil // A confirmed disappearance also fences historical lease restoration.
}
private struct PendingTodo: Codable {
    let id: String
    let namespace: String
    let revision: Int
    let done: Bool
    let note: String?
    let fileIds: [String]?
    var dropReason: String? = nil
    var dropped: Bool? = nil
}
private struct AppWriteJournal: Codable {
    var operations: [String: TrackedOperation] = [:]
    var todos: [String: PendingTodo] = [:]
    var unassignedRecoveries: [String: PendingUnassignedRecovery]? = nil
    var deliveryRecoveries: [String: PendingDeliveryRecovery]? = nil
    var projectChanges: [String: PendingProjectChange]? = nil
    var contextRequests: [String: PendingContextRequest]? = nil
    var serverEndpoints: [String: String]? = nil

    @discardableResult mutating func pruneTerminalHistory() -> Bool {
        let completed = operations.values.filter { $0.kind == .terminalControl && ($0.status == .applied || $0.status == .refused) }
            .sorted { ($0.order, $0.id) > ($1.order, $1.id) }
        var keep = Set(completed.prefix(64).map(\.id))
        // Keep one lease checkpoint per host/member, including a release tombstone.
        var checkpointMembers = Set<String>()
        for operation in completed where operation.status == .applied {
            let key = "\(operation.namespace.utf8.count):\(operation.namespace)|\(operation.memberID)"
            if checkpointMembers.insert(key).inserted { keep.insert(operation.id) }
        }
        // The current claim must survive >64 inputs so a later close can still persist its intent.
        // A release or a newer claim ends the previous active-claim checkpoint.
        var claimMembers = Set<String>()
        for operation in completed where operation.status == .applied && (operation.action == .claim || operation.action == .release) {
            let key = "\(operation.namespace.utf8.count):\(operation.namespace)|\(operation.memberID)"
            if claimMembers.insert(key).inserted, operation.action == .claim { keep.insert(operation.id) }
        }
        for operation in completed where operation.cancelledClaim == true { keep.insert(operation.id) }
        let oldCount = operations.count
        for operation in completed where !keep.contains(operation.id) { operations.removeValue(forKey: operation.id) }
        return operations.count != oldCount
    }
}

enum ProjectChangeStatus: String { case sending, checking, applied, current, refused }
private struct PendingProjectChange: Codable {
    let id: UUID
    let namespace: String
    let projectID: String
    let name: String?
    let cwd: String?
    let runnerEnabled: Bool?
    let now: String?
    let archived: Bool?
    init(namespace: String, projectID: String, request: PatchProjectRequest) {
        id = UUID()
        self.namespace = namespace; self.projectID = projectID
        name = request.name; cwd = request.cwd; runnerEnabled = request.runnerEnabled; now = request.now; archived = request.archived
    }
    func matches(_ project: Project) -> Bool {
        (name == nil || name?.trimmingCharacters(in: .whitespacesAndNewlines) == project.name)
            && (cwd == nil || cwd == project.cwd) && (runnerEnabled == nil || runnerEnabled == project.runnerEnabled)
            && (now == nil || now == project.now) && (archived == nil || archived == project.archived)
    }
}
private struct PendingContextRequest: Codable {
    let namespace: String
    let memberID: String
    let sessionID: String?
    let previousCompactionID: String?
}
@MainActor private final class WeakRouter {
    weak var value: Router?
    init(_ value: Router) { self.value = value }
}

private struct RefreshSnapshot: Sendable { let bootstrap: Bootstrap; let state: ProjectState?; let sync: SyncSnapshot? }

enum HistoryPagingSupport: Sendable { case unknown, supported, unsupported }
private struct PendingUnassignedRecovery: Codable {
    let id: String
    let namespace: String
    let projectID: String
    let messageID: String
    let version: Int
    let action: UnassignedRecoveryAction
    var result: UnassignedRecoveryResult? = nil
    var refused = false
}
private struct PendingDeliveryRecovery: Codable {
    let id: String
    let namespace: String
    let projectID: String
    let memberID: String
    let deliveryID: String
    let version: Int
    let action: DeliveryRecoveryAction
    let acceptDuplicateRisk: Bool
    var result: DeliveryRecoveryResult? = nil
    var refused = false
}
private actor HistoryRequestFailure {
    private(set) var error: Error?
    func record(_ error: Error) { self.error = error }
}
private struct AppHistoryService: MessageHistoryService {
    let api: APIClient
    let failure: HistoryRequestFailure
    func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        do { return try await api.messagePage(projectID: projectID, scope: scope, cursor: cursor, limit: limit) }
        catch { await failure.record(error); throw error }
    }
    func archivedMessagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        do { return try await api.archivedMessagePage(projectID: projectID, scope: scope, cursor: cursor, limit: limit) }
        catch { await failure.record(error); throw error }
    }
    func message(id: String) async throws -> Message { try await api.message(id: id) }
    func messagesAround(projectID: String, messageID: String, limit: Int) async throws -> [Message] {
        try await api.messagesAround(projectID: projectID, messageID: messageID, limit: limit)
    }
}

// Folder picker / GitHub import only. Demo browsing never reaches a server.
extension AppStore {
    var recentProjectParent: String? {
        guard let project = projects.last(where: { !$0.isHq && !$0.cwd.isEmpty }) else { return nil }
        return ServerFolderPaths.parent(project.cwd)
    }
    func folderBrowser() async throws -> FolderBrowserResult {
        if isDemo { return .listing(try demoFolderContents(path: nil)) }
        guard let api else { throw APIError(status: 0, message: "서버에 연결해 주세요.") }
        return try await api.folderBrowser()
    }
    func folderContents(path: String) async throws -> FolderListing {
        if isDemo { return try demoFolderContents(path: path) }
        guard let api else { throw APIError(status: 0, message: "서버에 연결해 주세요.") }
        return try await api.folderContents(path: path)
    }
    func preferredFolder(forClone: Bool = false) async throws -> FolderBrowserResult {
        let browser = try await folderBrowser()
        guard case .listing(let home) = browser else { return browser }
        if let recentProjectParent, let recent = try? await folderContents(path: recentProjectParent) { return .listing(recent) }
        if forClone, let code = try? await folderContents(path: ServerFolderPaths.appending("code", to: home.home)) { return .listing(code) }
        return .listing(home)
    }
    func createServerFolder(parent: String, name: String) async throws -> ServerFolder {
        guard !isDemo, canWrite, let api else { throw APIError(status: 0, message: "폴더 만들기는 연결된 서버에서만 할 수 있습니다.") }
        if let message = ServerFolderPaths.nameError(name) { throw APIError(status: 400, message: message) }
        return try await api.createFolder(parent: parent, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    func githubRepositories() async throws -> GitHubRepositories {
        if isDemo {
            return GitHubRepositories(available: true, repos: [
                GitHubRepository(nameWithOwner: "iamceo/landing", description: "새로운 브랜드와 제품을 소개하는 페이지", visibility: "PUBLIC", updatedAt: "2026-11-06T10:00:00Z", url: "https://github.com/iamceo/landing"),
                GitHubRepository(nameWithOwner: "iamceo/workspace", description: "우리 팀의 작업 공간", visibility: "PRIVATE", updatedAt: "2026-11-05T09:00:00Z", url: "https://github.com/iamceo/workspace")
            ])
        }
        guard let api else { throw APIError(status: 0, message: "서버에 연결해 주세요.") }
        return try await api.githubRepositories()
    }
    func startRepositoryClone(repo: String, parent: String) async throws -> String {
        guard !isDemo, canWrite, let api else { throw APIError(status: 0, message: "가져오기는 연결된 서버에서만 할 수 있습니다.") }
        return try await api.cloneRepository(repo: repo, parent: parent)
    }
    func repositoryCloneJob(_ id: String) async throws -> GitHubCloneJob {
        guard !isDemo, let api else { throw APIError(status: 0, message: "서버에 연결해 주세요.") }
        return try await api.cloneJob(id)
    }
    private func demoFolderContents(path: String?) throws -> FolderListing {
        let home = "/Users/demo"
        let tree = [home: ["code", "Documents"], home + "/code": ["landing", "workspace"], home + "/Documents": [], home + "/code/landing": ["assets", "src"], home + "/code/workspace": [], home + "/code/landing/assets": [], home + "/code/landing/src": []]
        let path = path ?? home
        guard let children = tree[path] else { throw APIError(status: 404, message: "샘플 폴더가 없습니다.") }
        return FolderListing(path: path, parent: path == home ? nil : ServerFolderPaths.parent(path), home: home,
                             entries: children.sorted { $0.localizedCompare($1) == .orderedAscending }.map { ServerFolder(name: $0, path: ServerFolderPaths.appending($0, to: path)) })
    }
}

/// The payload is stored as bounded Data, so the inactive cache has a real byte ceiling,
/// independent of the number or size of file bodies in a ProjectState. Never persisted to disk.
struct ProjectStateCache {
    let countLimit: Int
    let byteLimit: Int
    private var entries: [String: Data] = [:]
    private var recency: [String] = []
    private(set) var byteCount = 0
    var count: Int { entries.count }
    init(countLimit: Int = 4, byteLimit: Int = 8 * 1024 * 1024) {
        self.countLimit = max(0, countLimit); self.byteLimit = max(0, byteLimit)
    }
    private func key(_ id: String, _ archived: Bool) -> String { "\(archived):\(id)" }
    /// Shared by the app and tests; generic so an Encodable probe can verify the actual executor.
    static func encode<Value: Encodable & Sendable>(_ value: Value) async -> Data? {
        await Task.detached(priority: .utility) { try? JSONEncoder().encode(value) }.value
    }
    mutating func insert(_ state: ProjectState) async {
        let encoded = await Self.encode(state)
        insert(state, encoded: encoded)
    }
    mutating func insert(_ state: ProjectState, encoded data: Data?) {
        let key = key(state.project.id, state.project.archived)
        removeKey(key)
        guard countLimit > 0, let data, data.count <= byteLimit else { return }
        while entries.count >= countLimit || byteCount + data.count > byteLimit {
            guard let victim = recency.first else { break }
            removeKey(victim)
        }
        entries[key] = data; byteCount += data.count; recency.append(key)
    }
    mutating func value(projectID: String, archived: Bool) -> ProjectState? {
        let key = key(projectID, archived)
        guard let data = entries[key], let state = try? JSONDecoder().decode(ProjectState.self, from: data) else { return nil }
        recency.removeAll { $0 == key }; recency.append(key)
        return state
    }
    mutating func remove(projectID: String) { removeKey(key(projectID, false)); removeKey(key(projectID, true)) }
    private mutating func removeKey(_ key: String) {
        if let data = entries.removeValue(forKey: key) { byteCount -= data.count }
        recency.removeAll { $0 == key }
    }
    mutating func removeAll() { entries = [:]; recency = []; byteCount = 0 }
}
