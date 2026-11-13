import Foundation
import Observation
import Network
import OSLog
#if os(iOS)
import UIKit
#endif

/// 앱 상태 하나. 화면은 이 타입이 내놓는 값만 읽는다. 일이 많아 파일을 맡은 일별로 나눴다.
/// - AppStore.swift: 저장 값 전부, 연결·끊기, 프로젝트 고르기, 쓰기 공통 경로(perform), 보내기·결재·할 일·설정·팀원·프로젝트 관리
/// - AppStore+Connection.swift(+ ConnectionHealth.swift): 끊김·재시작·망 변화 판정
/// - AppStore+Sync.swift: 동기화 조정자(읽기 대기열, /api/sync, 실시간 소켓, 활동·진단 읽기)
/// - AppStore+WriteRecovery.swift(+ AppWriteJournal.swift): 쓰기 저널과 복구
/// - AppStore+Terminal.swift: 터미널 조작권
/// - AppStore+Notifications.swift: 알림 이동
/// Swift 의 `private` 은 파일 단위라, 다른 파일의 확장이 함께 쓰는 저장 값과 함수는 모듈 내부 접근이다.
/// 화면은 그것들을 직접 바꾸지 않는다(바꾸는 일은 이 타입의 함수로 한다).
@MainActor @Observable
final class AppStore: ProjectManagementStore {
    var endpoint: String
    var accessCode: String
    /// Captured at launch; typing credentials must never turn first-time setup into recovery.
    private(set) var restoredCredentials = false
    var connectionStatus: ConnectionStatus = .disconnected
    // Keep the server reason available for internal decisions; only the UI getter translates it.
    private(set) var rawErrorMessage: String?
    var errorMessage: String? {
        get { rawErrorMessage.map(TerminalPresentation.message) }
        set { rawErrorMessage = newValue }
    }
    /// whileBlocked: 보낼 수 없던 사정(연결 확인 중, 앞선 글 전송 중, 빈 입력칸)을 알린 안내. 사정이 풀리면 지운다.
    private struct SendNotice { let text: String; let whileBlocked: Bool }
    private var messageSendNotices: [String: SendNotice] = [:]
    private func sendNoticeKey(_ targetMemberID: String?) -> String {
        Self.scoped(writeNamespace, DraftStore.key(project: selectedProjectID, target: targetMemberID))
    }
    func messageSendNotice(targetMemberID: String?) -> String? { messageSendNotices[sendNoticeKey(targetMemberID)]?.text }
    func messageSendNoticeEndsWithBlock(targetMemberID: String?) -> Bool {
        messageSendNotices[sendNoticeKey(targetMemberID)]?.whileBlocked == true
    }
    func explainMessageSendBlock(_ reason: String, targetMemberID: String?, whileBlocked: Bool = true) {
        messageSendNotices[sendNoticeKey(targetMemberID)] = SendNotice(text: reason, whileBlocked: whileBlocked)
    }
    /// 입력칸이 다시 보낼 수 있게 되면 부른다. 실제 전송 실패의 설명은 남긴다.
    func clearBlockedSendNotice(targetMemberID: String?) {
        let key = sendNoticeKey(targetMemberID)
        if messageSendNotices[key]?.whileBlocked == true { messageSendNotices.removeValue(forKey: key) }
    }
    let terminalWake = TerminalWake()
    private(set) var isLoading = false
    /// A QR pairing claim is in flight (phone).
    private(set) var isPairing = false
    /// A pairing link waiting for the owner's yes. Nothing is sent to its address before that.
    private(set) var pairingRequest: PairingRequest?
    @ObservationIgnored private var pairingExpiryTask: Task<Void, Never>?
    /// The server this run already told its permission choice to (it may answer before its next snapshot does).
    /// It belongs to one connection to one server: disconnecting, or a different server answering at the same
    /// address, forgets it.
    var permissionChosenNamespace: String?
    @ObservationIgnored var permissionChoiceOffered: String?
    private(set) var pendingActions: Set<String> = []
    var terminalLeases: [String: TerminalLease] = [:]
    // Sheet ownership is independent of the employee's shared status strip. Queue
    // handoffs so a late claim/close can never release the next sheet's lease.
    @ObservationIgnored var terminalWindows: [UUID: String] = [:]
    var terminalWindowNotices: [String: String] = [:]
    @ObservationIgnored var terminalSessionTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var terminalSessionWanted: [String: UUID] = [:]
    @ObservationIgnored var terminalSessionHeld: [String: (owner: UUID, leaseID: String, namespace: String)] = [:]
    @ObservationIgnored var cancelledTerminalClaims: Set<String> = []
    @ObservationIgnored var terminalReleases: [String: Task<Bool, Never>] = [:]
    var apiOutage: APIOutage?
    var bootstrap: Bootstrap? {
        didSet {
            if bootstrap?.urls != oldValue?.urls { rememberServerAddresses() }
            if bootstrap?.cli != oldValue?.cli { rememberServerCLI() }
        }
    }
    var runtime: RuntimeDiagnostics?
    var selectedProjectID: String?
    var state: ProjectState? {
        didSet { updateStateCollections() }
    }
    var lastUpdated: Date?
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
    /// `state` 의 프로젝트 머리 값. 쓰기 판정·제목·전달 안내는 `state` 전체 대신 이것들을 읽어, 팀원 한 명의 상태가 바뀌어도
    /// 그 값을 읽는 화면이 다시 계산되지 않게 한다. `updateStateCollections`가 값이 바뀔 때만 갱신한다.
    private(set) var stateProjectID: String?
    private(set) var projectArchived: Bool?
    private(set) var projectConnectionOK: Bool?
    private(set) var projectName: String?
    var canWrite: Bool { capabilitiesLoaded && hasFreshProject && !showsOffline && !isRestarting && connectionStatus == .connected && !isRevalidating && !isArchive && projectArchived != true
        && selectedProjectID.map { projectResults[$0] != .checking } != false }
    /// A cached snapshot is for reading only. Realtime hosts need an atomic sync for this selection.
    /// Operations-only hosts validate revisions per write; an optional sync failure cannot lock all writes.
    private var hasFreshProject: Bool {
        selectedProjectID == nil || (validatedProjectGeneration == projectGeneration && stateProjectID == selectedProjectID
            && (!realtimeSupported || !syncSupported || validatedWriteGeneration == projectGeneration))
    }
    var currentProjectName: String {
        projectName ?? projects.first { $0.id == selectedProjectID }?.name
            ?? archivedProjects.first { $0.id == selectedProjectID }?.name ?? "IAMCEO"
    }
    var writeBlockedReason: String? {
        if isArchive || projectArchived == true { return String(localized: "보관한 프로젝트는 읽기 전용입니다") }
        // F1: 기기에 남겨 둔 마지막 상태를 보는 중(연결 전). 지금 상태가 아닐 수 있어 바꾸지 않는다.
        if lastSeen != nil { return String(localized: "마지막으로 본 상태라 지금은 바꿀 수 없습니다") }
        if let connectionNotice { return connectionNotice }
        if showsOffline { return String(localized: "서버와 연결이 끊겼습니다") }
        if connectionStatus != .connected { return String(localized: "잠시 연결을 확인하는 중") }
        if !hasFreshProject || (selectedProjectID != nil && stateProjectID == nil) { return String(localized: "프로젝트를 불러오는 중입니다") }
        if isRevalidating || !capabilitiesLoaded || selectedProjectID.map({ projectResults[$0] == .checking }) == true {
            return String(localized: "최신 상태를 다시 확인하는 중입니다")
        }
        if projectConnectionOK == false { return String(localized: "프로젝트의 실행 연결을 확인해 주세요") }
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
    var pagingSupport: HistoryPagingSupport = .unknown
    private(set) var isArchive = false
    private(set) var archivedProjects: [Project] = []
    private(set) var archiveError: String?
    private(set) var isLoadingArchive = false
    private(set) var projectResults: [String: ProjectChangeStatus] = [:]
    var projectNotice: String?
    private(set) var contextChecking: Set<String> = []
    var serverID: String?
    var pushConnectionError: PushSettingsError?
    var notificationNotice: String?
    /// The notice strip's 닫기: clears the notice itself (not one screen's copy), so it is gone on every tab.
    func dismissNotices() { notificationNotice = nil; projectNotice = nil }
    var notificationMessages: [Message] = []
    var notificationMessageID: String?
    @ObservationIgnored var notificationScope: MessageScope?
    let pushSettings: PushSettingsStore
    let pushNotifications: PushNotificationService?
    var knownServerEndpoints: [String: String] { journal.serverEndpoints ?? [:] }
    var pendingPushRevocations: [String] { pushNotifications?.pendingRevocations ?? [] }
    @ObservationIgnored var archiveObserved = false
    @ObservationIgnored var notificationFlight = false
    @ObservationIgnored var pendingNotification: NotificationLink?
    @ObservationIgnored var pendingNotificationOwner: (router: WeakRouter, revision: Int)?
    @ObservationIgnored var notificationRefreshRevision = 0
    @ObservationIgnored var pushLogoutTask: Task<Void, Never>?
    @ObservationIgnored var routers: [WeakRouter] = []
    private(set) var deliveryPages: [String: DeliveryNoticePage] = [:]
    private(set) var deliveryErrors: [String: String] = [:]
    private(set) var deliveryResults: [String: DeliveryRecoveryResult] = [:]
    var deliveryChecking: Set<String> = []
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
        // F1: 마지막으로 본 상태에는 이력 쪽이 없다. 그 상태에 든 최근 글만 보인다.
        if lastSeen != nil || (!isArchive && pagingSupport == .unsupported) {
            let scope = ChatHistoryKey.normalizedScope(targetMemberID: historyTarget, members: members)
            return messages.filter { row in
                if case .member(let id) = scope { return row.memberId == id || row.targetMemberId == id }
                return true
            }
        }
        return history?.items ?? []
    }
    /// `state` 의 전달 안내(판 2만). `updateStateCollections`가 값이 바뀔 때만 갱신한다.
    private(set) var deliveryNotices: DeliveryNotices?
    /// Only server-confirmed owner requests are interventions. Checking/waiting counts overlap totals.
    var deliveryAttentionMembers: [MemberDeliverySummary] { deliveryNotices?.members.filter { $0.needsOwnerCount > 0 } ?? [] }
    var unassignedDeliveries: [UnassignedDeliveryItem] { deliveryNotices?.unassignedItems ?? [] }
    var unassignedDeliveryAttentionCount: Int { deliveryNotices?.unassigned.needsOwnerCount ?? 0 }
    func deliverySummary(memberID: String) -> MemberDeliverySummary? {
        deliveryNotices?.members.first { $0.memberId == memberID }
    }
    @ObservationIgnored private var historyTarget: String?
    @ObservationIgnored var historyVisible = false
    // Unique live registrations, ordered so a disappearing screen falls back to the latest survivor.
    @ObservationIgnored private var historyOwners: [(id: UUID, key: ChatHistoryKey?, targetMemberID: String?)] = []
    @ObservationIgnored private var historyFlight: (key: ChatHistoryKey, id: UUID, revision: Int, task: Task<Void, Never>)?
    @ObservationIgnored private var historyRestoration: (key: ChatHistoryKey, id: UUID, task: Task<Void, Never>)?
    @ObservationIgnored var historyInvalidationRevision = 0
    @ObservationIgnored var deliveryFlights: [String: UUID] = [:]
    @ObservationIgnored private var deliveryRefreshPending: Set<String> = []
    @ObservationIgnored private var archiveLoad = UUID()
    /// The server stopped answering after a successful connect. The last snapshot stays on screen (read-only),
    /// fallback keeps retrying, and the next successful refresh returns to `.connected`.
    var connectionLost: Bool { showsOffline }
    var showsOffline = false
    var isRestarting = false
    var isCheckingConnection = false
    var connectionNotice: String? {
        if isRestarting { return String(localized: "서버를 다시 시작하는 중") }
        // 연결은 되는데 응답을 거듭 해석하지 못하는 것은 '연결 확인'이 아니다. 기다려도 풀리지 않으니 사실대로 알린다.
        if !showsOffline, isCheckingConnection, unreadableFailures >= 3 { return String(localized: "앱과 서버 버전이 맞지 않아 최신 상태를 읽지 못했습니다") }
        if !showsOffline, isCheckingConnection { return String(localized: "잠시 연결을 확인하는 중") }
        return nil
    }
    /// Why the last sync failed while `connectionLost` (system wording, e.g. no internet vs. server not answering).
    var connectionIssue: String?
    var realtimeStatus: RealtimeStatus = .paused
    var isRevalidating = false
    var lastHeartbeatAt: Date?
    var lastSyncAttemptAt: Date?
    var lastSuccessfulSyncAt: Date?
    var receivedCursor: SyncCursor?
    var appliedSnapshotCursor: SyncCursor?
    var dirtyRevision = 0
    var resyncRevision = 0
    var activityRevisions: [String: Int] = [:]
    var activities: [String: [Activity]] = [:]
    /// 등록을 store가 비울 때마다 오른다. 떠 있는 활동 목록이 이것을 보고 다시 등록한다.
    private(set) var activityEpoch = 0
    var activityErrors: [String: String] = [:]
    var syncDescription: String {
        if isDemo { return "Sample workspace" }
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
    /// F8: 샘플 모드의 가짜 서버. 샘플이 아니면 nil.
    @ObservationIgnored let sampleServer: SampleServer?
    /// C8: 이 기기의 Tailscale 이 켜져 있는가. 연결(APIClient)과 QR 교환이 Tailscale 주소로 평문을 보내기 전에 본다.
    /// 시험은 시험 기기의 Tailscale 상태에 기대지 않게 바꿔 넣는다. 바꾼 값은 다음 연결부터 쓴다.
    @ObservationIgnored var tailnetConnected: @Sendable () -> Bool = { Tailnet.isConnected() }
    @ObservationIgnored private let persistCredentials: Bool
    @ObservationIgnored var generation = UUID()
    @ObservationIgnored var projectGeneration = UUID()
    @ObservationIgnored var refreshGeneration = UUID()
    @ObservationIgnored let realtime: RealtimeClient?
    @ObservationIgnored let syncClock: any RealtimeClock
    @ObservationIgnored let retryJitter: @Sendable (Double) -> Double
    @ObservationIgnored let lowPowerMode: Bool
    @ObservationIgnored var socketGeneration = UUID()
    @ObservationIgnored var foregroundGeneration = UUID()
    @ObservationIgnored var coordinatorGeneration = UUID()
    @ObservationIgnored var socketTask: Task<Void, Never>?
    @ObservationIgnored var socketTransition: Task<Void, Never>?
    @ObservationIgnored var reconnectTask: Task<Void, Never>?
    @ObservationIgnored var fallbackTask: Task<Void, Never>?
    @ObservationIgnored var coordinatorTask: Task<Void, Never>?
    @ObservationIgnored var refreshWaiters: [UUID: (revision: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
    /// 쓰기 뒤 새로고침에서 스냅샷이 반영되는 즉시 한 번 부른다. 나머지 읽기는 기다리지 않는다.
    @ObservationIgnored var snapshotHooks: [UUID: (revision: Int, action: @MainActor () -> Void)] = [:]
    @ObservationIgnored var dirty: RefreshScope = []
    @ObservationIgnored var nextSnapshotAt: Duration = .zero {
        didSet { if nextSnapshotAt == .zero { eventSnapshotAt = .zero } }
    }
    /// 실시간 이벤트가 부르는 읽기는 직전 읽기에 걸린 시간만큼 더 쉰다. 서버가 느릴수록 앱이 물러난다.
    /// 대표가 누른 새로고침·쓰기 뒤 읽기·재연결(immediate)은 이 간격을 기다리지 않는다.
    @ObservationIgnored var eventSnapshotAt: Duration = .zero
    @ObservationIgnored var urgentRefresh = false
    @ObservationIgnored var pacingTask: Task<Void, Never>?
    /// 읽기 한 번의 끝에 도는 복구 조회의 표식. 복구가 띄운 작업에도 이어진다. 그 안에서 부른 새로고침은
    /// 자기 자신(돌고 있는 읽기)이 끝나기를 기다리게 되므로 구분한다.
    @TaskLocal static var recoveryPass: UUID?
    @ObservationIgnored var activeRecoveryPass: UUID?
    @ObservationIgnored var syncSupported = false
    @ObservationIgnored var realtimeSupported = false
    var capabilitiesLoaded = false
    @ObservationIgnored var socketHello = false
    @ObservationIgnored var highestRelevantSeq = 0
    var socketFailures = 0
    var restFailures = 0
    @ObservationIgnored var lastSocketFrame: Duration?
    /// 끊김·재시작·망 변화 판정의 근거(ConnectionHealth.swift).
    @ObservationIgnored var health = ConnectionHealth()
    var unreadableFailures = 0
    @ObservationIgnored var offlineTask: Task<Void, Never>?
    @ObservationIgnored var syncRetryTask: Task<Void, Never>?
    @ObservationIgnored var restartTask: Task<Void, Never>?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    @ObservationIgnored private var lifecycleObservers: [NSObjectProtocol] = []
    static let connectionLogger = Logger(subsystem: "com.iamceo.native", category: "Connection")
    @ObservationIgnored var openActivityMembers: Set<String> = []
    @ObservationIgnored var activityWatchCounts: [String: Int] = [:]
    /// 지금 화면에 떠 있는 직원 상세만 전달 안내를 자동으로 다시 읽는다. 열어 봤던 직원 전부가 아니다.
    @ObservationIgnored var deliveryWatchers: [UUID: String] = [:]
    @ObservationIgnored var activityTokens: [String: UUID] = [:]
    @ObservationIgnored var initialTask: Task<Bootstrap, Error>?
    @ObservationIgnored private var pendingConnect = false
    @ObservationIgnored var refreshTask: Task<RefreshSnapshot, Error>?
    @ObservationIgnored var foreground = true
    let drafts: DraftStore
    let composerUploads = ComposerAttachmentUploads()
    let submissions: SubmissionStore?
    /// F1(4차 S): 마지막으로 본 상태와 연결되면 보낼 글(AppStore+Offline.swift, OfflineState.swift).
    let offline: OfflineStateStore
    /// 지금 화면의 상태가 기기에 남겨 둔 마지막 상태인가(연결 전, 읽기 전용). 서버가 새 상태를 주면 nil.
    var lastSeen: LastSeenInfo?
    /// '마지막으로 본 상태' 줄을 띄울 때가 됐는가(잠깐 기다렸거나 연결이 실패했다).
    var lastSeenAnnounced = false
    /// 연결되면 보낼 글을 지금 보내는 중.
    var outboxFlushing = false
    @ObservationIgnored var lastSeenSaveTask: Task<Void, Never>?
    @ObservationIgnored var lastSeenSavedAt: Date?
    @ObservationIgnored var lastSeenNoticeTask: Task<Void, Never>?
    @ObservationIgnored var lastSeenPeek: NotificationLink?
    /// Mac 앱이 이 Mac 의 서버(127.0.0.1)에 붙을 때는 마지막 상태를 쓰지 않는다(서버가 꺼져 있으면 연결 화면의
    /// '이 Mac에서 시작'이 답이다). 시험은 시험 서버가 127.0.0.1 이라 켠다.
    @ObservationIgnored var lastSeenOnThisMac = false
    var writeRevisions: SyncRevisions?
    var settingsEdit: SettingsEdit?
    private(set) var settingsConflict: Settings?
    var todoWrites: [String: TodoWriteState] = [:]
    var operationResults: [String: OperationReceipt] = [:]
    private(set) var batchResults: [String: CardWriteStatus] = [:]
    /// F1 의 마지막 상태 복원(AppStore+Offline.swift)도 바꾼다. 화면은 바꾸지 않는다.
    var writeNamespace = "unassigned"
    @ObservationIgnored let writeStorage: LocalStateStorage
    @ObservationIgnored var journal = AppWriteJournal()
    @ObservationIgnored var persistenceFailure: String?
    @ObservationIgnored var reviewedSettings: Settings?
    @ObservationIgnored var reviewedMembers: [String: Member] = [:]
    @ObservationIgnored var reviewedTodos: [String: Todo] = [:]
    @ObservationIgnored var recoveryInFlight = false
    @ObservationIgnored private var writeContextGeneration = UUID()
    @ObservationIgnored var leaseReceiptOrder: [String: Int] = [:]
    @ObservationIgnored var absentOperations: Set<String> = []
    @ObservationIgnored var announcedUnresolved: Set<String> = []
    @ObservationIgnored var strictWriteContract = false
    @ObservationIgnored private var lastReadError: String?
    /// Endpoint and code of the live client, so a reconnect from the offline strip can keep the last snapshot.
    @ObservationIgnored var connectedCredentials: (endpoint: String, code: String)?
    /// 쓰기 판정(canWrite·writeBlockedReason)이 읽는다. 판정이 `state` 전체를 읽지 않게 된 뒤로는 확인이 끝나 이 값이 바뀌는 것이
    /// 그 값을 읽는 화면을 다시 그리는 계기라 관찰한다(같은 값을 다시 넣으면 알리지 않는다).
    var validatedProjectGeneration: UUID?
    var validatedWriteGeneration: UUID?
    @ObservationIgnored var projectCache = ProjectStateCache()
    @ObservationIgnored private var selectionRequestID = UUID()
    @ObservationIgnored var appliedSyncIdentity: AppliedSyncIdentity?
    @ObservationIgnored let navigationDefaults: UserDefaults?
    @ObservationIgnored private var pendingDraftRecovery = false
    @ObservationIgnored private var catalogDiscoveryTask: Task<Void, Never>?
    /// 저장해 둔 연결은 첫 접속이 일시적으로 실패해도 같은 주소로 알아서 다시 시도한다.
    @ObservationIgnored var retriesSavedConnection = false
    @ObservationIgnored var retryableConnect: (endpoint: String, code: String)?
    @ObservationIgnored private var connectRetryTask: Task<Void, Never>?
    @ObservationIgnored private var connectRetryAttempt = 0
    @ObservationIgnored var resumeNoticeTask: Task<Void, Never>?
    @ObservationIgnored var pathChangeTask: Task<Void, Never>?
    @ObservationIgnored var seededBootstrap: Bootstrap?
    @ObservationIgnored var fullPassCursor: SyncCursor?
    @ObservationIgnored var lastSnapshotCursor: SyncCursor?
    @ObservationIgnored var capabilityProbeFailed = false
    @ObservationIgnored var pushRetryTask: Task<Void, Never>?
    @ObservationIgnored var pushRetryAttempt = 0
    @ObservationIgnored private var actionOwners: [String: UUID] = [:]
    @ObservationIgnored private var projectRechecks: [String: Double] = [:]
    /// 응답을 잃은 쓰기를 닫을 때 재는 시각(초). 시험에서 바꿔 끼운다.
    @ObservationIgnored var wallClock: @MainActor () -> Double = { Date().timeIntervalSince1970 }
    @ObservationIgnored var activePassRevision: Int?

    init(demo: Bool = false, session: URLSession? = nil, persistCredentials: Bool = true,
         drafts: DraftStore? = nil, submissions: SubmissionStore? = nil, writeStorageURL: URL? = nil,
         realtime: RealtimeClient? = nil, clock: any RealtimeClock = SystemRealtimeClock(),
         retryJitter: @escaping @Sendable (Double) -> Double = { $0 * Double.random(in: 0.8...1.2) },
         lowPowerMode: Bool = ProcessInfo.processInfo.isLowPowerModeEnabled,
         pushNotifications: PushNotificationService? = nil, navigationDefaults: UserDefaults? = nil,
         restoreCredentials: Bool = true, offline: OfflineStateStore? = nil) {
        self.navigationDefaults = demo ? nil : (navigationDefaults ?? (persistCredentials ? .standard : nil))
        // F8: 샘플은 기기 안의 가짜 서버에 실제 연결과 같은 길로 붙는다. 넘겨받은 세션·실시간 연결은 쓰지 않는다
        // (샘플의 요청은 어떤 경우에도 그 서버 밖으로 나가지 않는다).
        let sample = demo ? SampleServer() : nil
        sampleServer = sample
        injectedSession = sample?.session ?? session
        // URLProtocol cannot intercept a WebSocket upgrade. Injected HTTP sessions must also
        // inject a socket transport to opt in; tests can never escape to the real network.
        self.realtime = sample.map { RealtimeClient(factory: $0.realtimeFactory, clock: clock) } ?? (realtime ?? (session == nil ? RealtimeClient() : nil))
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
        // F1: 샘플과 기기에 남기지 않는 실행(시험)은 마지막 상태도 대기열도 파일로 남기지 않는다.
        self.offline = offline ?? OfflineStateStore(persist: persistCredentials && !demo)
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
        retriesSavedConnection = restoredCredentials && !demo
        if let sample {
            endpoint = SampleServer.endpoint
            accessCode = SampleServer.accessCode
            composerUploads.sessionConfiguration = sample.configuration
            Task { [weak self] in await self?.connect() }
        }
        updateStateCollections()
        // F1: 저장한 연결의 마지막 상태가 있으면 빈 연결 화면 대신 그것을 읽기 전용으로 띄운다(연결은 화면이 평소대로 시작한다).
        if restoreCredentials && restoredCredentials { restoreLastSeen() }
        // Injected test sessions never subscribe to the machine's network or application lifecycle.
        if session == nil, !demo {
            let monitor = NWPathMonitor()
            pathMonitor = monitor
            monitor.pathUpdateHandler = { [weak self] path in
                let satisfied = path.status == .satisfied
                // 실제로 쓰는 망(맨 앞)과 VPN 터널만 본다. 보조 망이 생겼다 사라지는 것은 길이 바뀐 것이 아니다.
                let primary = path.availableInterfaces.first.map { "\($0.name):\($0.type)" } ?? "-"
                let tunnels = path.availableInterfaces.filter { $0.type == .other }.map(\.name).sorted().joined(separator: ",")
                let interfaces = primary + "|" + tunnels
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // 이 Mac 안의 서버(127.0.0.1)는 망이 바뀌어도 연결이 그대로다.
                    networkPathChanged(satisfied: satisfied, interfaces: AppStore.isLoopback(endpoint) ? nil : interfaces)
                }
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
        let project = state?.project
        if stateProjectID != project?.id { stateProjectID = project?.id }
        if projectArchived != project?.archived { projectArchived = project?.archived }
        if projectConnectionOK != project?.connection.ok { projectConnectionOK = project?.connection.ok }
        if projectName != project?.name { projectName = project?.name }
        let notices = state?.deliveryNotices?.version == 2 ? state?.deliveryNotices : nil
        if deliveryNotices != notices { deliveryNotices = notices }
    }

    func connect() async {
        connectRetryAttempt = 0
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
        let reconnecting = connectedCredentials.flatMap { try? ServerEndpoint($0.endpoint) }.map { previous in
            (try? ServerEndpoint(endpoint)).map { DraftStore.endpointNamespace($0) == DraftStore.endpointNamespace(previous) } ?? false
        } ?? false
        // F1: 마지막으로 본 상태를 띄운 채 같은 서버에 붙으면 그 상태와 초안 자리를 이어 쓴다(같은 서버로 다시 붙는 것과 같다).
        // 다른 서버로 바꾸면 그 상태는 지운다.
        let keepsLastSeen = lastSeenMatches(endpoint)
        if lastSeen != nil, !keepsLastSeen { forgetLastSeen() }
        let sameServer = reconnecting || keepsLastSeen
        let idleNamespace = keepsLastSeen ? (lastSeen?.namespace ?? "unassigned") : "unassigned"
        retryableConnect = nil
        guard foreground else {
            // A requested host change invalidates writes/uploads now, even though networking
            // waits for the next active phase. A → B → A must reject A's late callbacks too.
            pendingConnect = true; stopRequests()
            generation = UUID(); projectGeneration = UUID()
            if !sameServer { clearHostNavigation(); projectCache.removeAll() }
            pushNotifications?.setHost(nil); pushSettings.setHost(nil)
            api = nil; connectionStatus = .disconnected; isLoading = false; isRevalidating = true
            drafts.selectNamespace(idleNamespace); writeNamespace = idleNamespace
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
        drafts.selectNamespace(idleNamespace)
        writeRevisions = nil; reviewedSettings = nil; reviewedMembers = [:]; reviewedTodos = [:]
        settingsEdit = nil; settingsConflict = nil; todoWrites = [:]; operationResults = [:]; batchResults = [:]
        leaseReceiptOrder = [:]; absentOperations = []; announcedUnresolved = []; writeContextGeneration = UUID()
        strictWriteContract = false; syncSupported = false; realtimeSupported = false; capabilitiesLoaded = false
        capabilityProbeFailed = false; seededBootstrap = nil; fullPassCursor = nil; lastSnapshotCursor = nil; pushRetryAttempt = 0
        receivedCursor = nil; appliedSnapshotCursor = nil; highestRelevantSeq = 0
        socketFailures = 0; restFailures = 0; nextSnapshotAt = .zero
        resetReadCollections()
        let epoch = generation
        lastReadError = nil
        connectionStatus = .connecting
        api = nil
        connectedCredentials = nil; health.transportFailures = 0
        // F1: 마지막 상태를 보는 채 같은 서버에 다시 붙는 동안(자동 재시도)은 앞선 실패의 까닭을 지우지 않는다.
        // 지우면 재시도마다 줄이 '받는 중' 한 줄과 까닭 석 줄 사이를 오가며 높이가 바뀐다(4차 리뷰 ui-4).
        if !keepsLastSeen { connectionIssue = nil }
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
            guard !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(status: 0, message: String(localized: "접속 코드를 넣어 주세요.")) }
            let client = APIClient(endpoint: validated, accessCode: accessCode.trimmingCharacters(in: .whitespacesAndNewlines), session: injectedSession, liteStateEnabled: true,
                                   tailnetConnected: tailnetConnected)
            let task = Task { try await client.request("/api/bootstrap") as Bootstrap }
            initialTask = task
            let initial = try await task.value
            guard epoch == generation, foreground, !Task.isCancelled else { return }
            initialTask = nil
            // 기능 조회는 가벼운 요청이라 화면을 읽기 전에 잠깐만 기다린다. 먼저 끝나면 첫 읽기가 /api/sync 한 번으로 끝난다.
            // 늦으면 기다리지 않고 예전 순서대로 화면부터 읽는다.
            let discovery = Task { [weak self] in
                guard let self else { return }
                await discoverCapabilities(using: client)
            }
            await waitBriefly(for: discovery, atMost: .seconds(1))
            guard epoch == generation, foreground, !Task.isCancelled else { return }
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
            // F1: 새로 붙은 서버다. 앞서 남긴 다른 연결의 마지막 상태는 지운다(이 서버의 상태는 곧 다시 남긴다).
            // 다른 서버에 보내려던 대기열도 지운다. 이 서버 몫은 그대로 둔다(접속 코드가 바뀌어 같은 서버에 다시 붙은 경우).
            if !sameServer {
                offline.clearLastSeen()
                try? offline.removeAll(except: writeNamespace)
            }
            rememberServerAddresses()
            rememberServerCLI()
            connectionIssue = nil
            connectionStatus = .connected
            connectRetryAttempt = 0
            // Reading the workspace never waits for the model catalog, and waits for the capability probe only briefly.
            catalogDiscoveryTask = Task { [weak self] in await self?.refreshModels() }
            // 구형 순서로 읽게 되더라도 방금 받은 bootstrap을 다시 받지 않는다.
            if !capabilitiesLoaded || !syncSupported { seededBootstrap = initial }
            // 샘플은 저장해 둔 화면이 없다. 실행 인자로 연 화면을 지키고 본사 말고 첫 프로젝트를 연다.
            if !sameServer, !isDemo { restoreNavigation() }
            let saved = isDemo ? initial.projects.first(where: { !$0.isHq })?.id : sameServer ? (previousProject ?? savedProjectID()) : savedProjectID()
            if sameServer, previousArchive, let saved {
                await selectArchivedProject(id: saved)
            } else if let project = initial.projects.first(where: { $0.id == saved })
                ?? initial.projects.first(where: { $0.isHq || $0.id == "hq" }) ?? initial.projects.first {
                await selectProject(id: project.id)
            }
            seededBootstrap = nil
            await discovery.value
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
            // 서버가 아직 뜨는 중이거나 망이 늦게 붙은 실패는 같은 주소로 알아서 다시 시도한다.
            // 접속 코드·주소 오류는 다시 시도하지 않는다.
            if retriesSavedConnection, ConnectionHealth.isUnreachable(error) {
                retryableConnect = (endpoint, accessCode)
                scheduleConnectRetry()
            }
            // F1: 마지막 상태를 띄운 채였다면, 서버에 닿지 않은 실패는 그 상태를 두고 줄에 까닭을 보인다.
            lastSeenConnectFailed(error)
        }
    }

    /// `task`가 끝나거나 `limit`이 지날 때까지만 기다린다. `task`는 취소하지 않는다.
    private func waitBriefly(for task: Task<Void, Never>, atMost limit: Duration) async {
        let timer = Task { [syncClock] in _ = try? await syncClock.sleep(for: limit) }
        let watcher = Task { await task.value; timer.cancel() }
        await timer.value
        watcher.cancel()
    }

    private static func isLoopback(_ endpoint: String) -> Bool {
        ["127.0.0.1", "localhost", "::1"].contains((try? ServerEndpoint(endpoint))?.url.host ?? "")
    }

    func scheduleConnectRetry(immediately: Bool = false) {
        guard foreground, api == nil, connectionStatus == .failed, let target = retryableConnect else { return }
        connectRetryTask?.cancel()
        if immediately { connectRetryAttempt = 0 }
        let cap: Double = Self.isLoopback(target.endpoint) ? 3 : 15
        let delay = immediately ? 0 : min(cap, max(0, retryJitter(min(cap, pow(2, Double(min(connectRetryAttempt, 4)))))))
        connectRetryAttempt += 1
        let epoch = generation, phase = foregroundGeneration
        connectRetryTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: .seconds(delay)) } catch { return }
            // 그사이 주소나 코드를 고쳤으면 옛 값으로 다시 붙지 않는다.
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground,
                  api == nil, connectionStatus == .failed,
                  endpoint == target.endpoint, accessCode == target.code else { return }
            connectRetryTask = nil
            await establishConnection()
        }
    }

    /// Restart transport and revalidate without changing project, drafts, windows, or route.
    func restartRealtime() async {
        guard api != nil, bootstrap != nil else { await establishConnection(); return }
        socketFailures = 0; restFailures = 0; health.transportFailures = 0; nextSnapshotAt = .zero
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
        // 알림 연결 조회가 앞서 실패해 비어 있으면 '다시 연결'에서도 다시 묻는다.
        if serverID == nil, api != nil { await refreshPushConnection() }
    }

    var navigationKey: String { "iamceo.navigation.v1." + writeNamespace }
    private func savedProjectID() -> String? {
        navigationDefaults?.dictionary(forKey: navigationKey)?["projectID"] as? String
    }
    func saveNavigation(destination: Destination? = nil) {
        guard writeNamespace != "unassigned" else { return }
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
        sampleServer?.shutdown()
    }

    func disconnect() {
        retryableConnect = nil; retriesSavedConnection = false
        permissionChoiceOffered = nil; permissionChosenNamespace = nil; holdPairingRequest(nil)
        forgetServerAddresses(for: endpoint)
        forgetServerCLI()
        resetConnectionEvidence()
        beginPushLogout()
        clearHostNavigation()
        NotificationInbox.shared.discardPending()
        releaseAllTerminals()
        stopRequests()
        resetReadCollections()
        // F1: 이 기기에서 나간다. 마지막 상태와 이 서버에 보내려던 대기열을 지운다(나가기 확인 창이 그 수를 알린다).
        forgetLastSeen()
        if writeNamespace != "unassigned" { try? offline.removeAll(namespace: writeNamespace) }
        projectCache.removeAll(); validatedProjectGeneration = nil; validatedWriteGeneration = nil
        generation = UUID(); projectGeneration = UUID()
        if persistCredentials { KeychainStore.remove(for: endpoint) }
        realtimeStatus = .paused; isRevalidating = false
        receivedCursor = nil; appliedSnapshotCursor = nil
        modelCatalog = .fallback
        api = nil; accessCode = ""; apiOutage = nil; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
        restoredCredentials = false
        connectedCredentials = nil; health.transportFailures = 0; connectionIssue = nil
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

    func selectProject(id: String, archived: Bool, navigationToken: UUID? = nil) async {
        guard api != nil, connectionStatus == .connected else {
            if id != selectedProjectID || archived != isArchive { explainLastSeenSelection() }
            return
        }
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
        openActivityMembers.removeAll(); activityWatchCounts = [:]; activities = [:]; activityErrors = [:]; activityEpoch &+= 1
        await enqueueRefresh(.all, immediate: true, allowPaused: true)
        guard epoch == generation, projectEpoch == projectGeneration else { return }
    }

    func refreshModels() async {
        guard let api else { return }
        let epoch = generation
        if let modelsTask {
            let requestID = modelsRequestID
            let catalog = try? await modelsTask.value
            // 끝난 요청은 먼저 깨어난 쪽이 치운다. 남겨 두면 바로 다음 새로고침이 끝난 요청에 합류해 아무것도 받지 않는다.
            if requestID == modelsRequestID { self.modelsTask = nil }
            if let catalog, epoch == generation, requestID == modelsRequestID, !modelsTask.isCancelled { modelCatalog = catalog }
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
        if !active, injectedSession == nil || sampleServer != nil, UIApplication.shared.applicationState != .background { return }
        #endif
        guard foreground != active else { return }
        foreground = active; foregroundGeneration = UUID()
        // F1: 앞으로 나오면 잠긴 동안 못 읽은 대기열을 다시 읽고, 뒤로 가면 서버가 확인해 준 마지막 상태를 남긴다.
        if active { offline.reloadIfNeeded() } else { Task { [weak self] in await self?.saveLastSeenNow() } }
        if active {
            if pendingConnect {
                Task { [weak self] in await self?.connect() }
                return
            }
            if api == nil, connectionStatus == .failed, retryableConnect != nil {
                scheduleConnectRetry(immediately: true)
                return
            }
            guard api != nil, connectionStatus == .connected || connectionLost else { return }
            // 쓰기는 새 스냅샷이 올 때까지 잠그되, '연결을 확인하는 중' 문구는 2초 넘게 걸릴 때만 보인다.
            // 읽기가 실제로 실패하면 문구는 기존 경로에서 바로 켜진다.
            isRevalidating = true
            resumeNoticeTask?.cancel()
            let noticeEpoch = generation, noticePhase = foregroundGeneration
            resumeNoticeTask = Task { [weak self, syncClock] in
                do { try await syncClock.sleep(for: .seconds(2)) } catch { return }
                guard let self, !Task.isCancelled, noticeEpoch == generation, noticePhase == foregroundGeneration,
                      foreground, isRevalidating else { return }
                resumeNoticeTask = nil
                isCheckingConnection = true
            }
            socketFailures = 0; restFailures = 0; health.transportFailures = 0; health.firstTransportFailure = nil
            health.foregroundRetry = 0; nextSnapshotAt = .zero
            startSocket(); startFallback()
            var scope: RefreshScope = runtime == nil ? [.all, .diagnostics] : .all
            if archiveObserved { scope.insert(.archive) }
            Task { [weak self] in
                guard let self else { return }
                let epoch = generation, phase = foregroundGeneration
                health.foregroundGraceUntil = await syncClock.now() + .seconds(5)
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

    /// F1 의 대기열 보내기(AppStore+Offline.swift)도 같은 잠금을 쓴다.
    func holdAction(_ key: String) -> UUID {
        let owner = UUID()
        pendingActions.insert(key); actionOwners[key] = owner
        return owner
    }
    /// 잠금을 건 쪽만 푼다. 먼저 풀린 뒤 같은 키로 시작한 다음 동작의 잠금은 건드리지 않는다.
    func releaseAction(_ key: String, owner: UUID) {
        guard actionOwners[key] == owner else { return }
        actionOwners.removeValue(forKey: key); pendingActions.remove(key)
    }

    private func stopRequests() {
        offlineTask?.cancel(); offlineTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        connectRetryTask?.cancel(); connectRetryTask = nil
        resumeNoticeTask?.cancel(); resumeNoticeTask = nil
        pathChangeTask?.cancel(); pathChangeTask = nil
        pushRetryTask?.cancel(); pushRetryTask = nil
        catalogDiscoveryTask?.cancel(); catalogDiscoveryTask = nil
        modelsTask?.cancel(); modelsTask = nil
        modelsRequestID = UUID()
        cancelHistoryLoad(); invalidateCoordinator(); stopSocket()
        fallbackTask?.cancel(); fallbackTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
    }
    func clearReadError() {
        if let lastReadError, errorMessage == lastReadError { errorMessage = nil }
        lastReadError = nil
    }
    func handle(_ error: Error) {
        errorMessage = error.localizedDescription
        if (error as? APIError)?.status == 401 {
            retryableConnect = nil
            resetConnectionEvidence()
            beginPushLogout(); clearHostNavigation()
            NotificationInbox.shared.discardPending()
            // F1: 접속 코드가 거절됐다. 그 연결로 남긴 마지막 상태는 지운다(대기열은 같은 서버에 다시 들어오면 보낸다).
            forgetLastSeen()
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
    func mutate<T: Sendable>(_ key: String, refreshAfter: Bool = true, operation: (APIClient) async throws -> T) async -> T? {
        await perform(key, refreshAfter: refreshAfter, operation: operation).value
    }
    /// Like `mutate`, but also returns the server/transport error so callers can tell "the server refused" from
    /// "we never heard back". `error == nil` with no value means the request was not sent.
    func perform<T: Sendable>(_ key: String, refreshAfter: Bool = true, allowArchived: Bool = false, cancellationAware: Bool = false, deferRefusalToReceipt: Bool = false, ownsPendingAction: Bool = false, operation: (APIClient) async throws -> T) async -> (value: T?, error: Error?) {
        guard let api, canWrite || (allowArchived && connectionStatus == .connected && !isRevalidating) else { errorMessage = isArchive ? String(localized: "보관한 프로젝트는 읽기 전용입니다.") : String(localized: "서버에 연결된 뒤에 바꿀 수 있습니다."); return (nil, nil) }
        guard ownsPendingAction || !pendingActions.contains(key) else { return (nil, nil) }
        let epoch = generation
        let owner: UUID? = ownsPendingAction ? nil : holdAction(key)
        errorMessage = nil
        if key.hasPrefix("terminal:") { terminalWindowNotices.removeValue(forKey: String(key.dropFirst("terminal:".count))) }
        defer { if epoch == generation, let owner { releaseAction(key, owner: owner) } }
        do {
            let result = try await operation(api)
            if cancellationAware && Task.isCancelled { return (nil, nil) }
            guard epoch == generation else { return (nil, nil) }
            if refreshAfter {
                // 서버가 받은 변경이 스냅샷으로 화면에 반영되면 버튼 잠금을 먼저 푼다.
                // 대화·전달 읽기까지 끝나기를 기다리며 '보내는 중'으로 묶어 두지 않는다.
                var release: (@MainActor () -> Void)?
                if let owner { release = { [weak self] in self?.releaseAction(key, owner: owner) } }
                await refresh(onSnapshot: release)
            }
            guard epoch == generation else { return (nil, nil) }
            return (result, nil)
        } catch {
            guard epoch == generation else { return (nil, error) }
            if cancellationAware && Task.isCancelled { return (nil, error) }
            if key.hasPrefix("terminal:"), terminalRefusalIsLocal(memberID: String(key.dropFirst("terminal:".count)), error: error) {
                terminalWindowNotices[String(key.dropFirst("terminal:".count))] = error.localizedDescription
            }
            let deferredRefusal = deferRefusalToReceipt && Self.definiteRefusal(error) && (error as? APIError)?.status != 401
            if !deferredRefusal && (!key.hasPrefix("terminal:") || !terminalRefusalIsLocal(memberID: String(key.dropFirst("terminal:".count)), error: error)) {
                handle(error)
            }
            // A conflict means our copy is stale: show the truth right away. A missing terminal
            // is definitive; do not reconcile its in-flight operation before recording the refusal.
            if !deferredRefusal, (error as? APIError)?.status == 409, !(key.hasPrefix("terminal:") && ServerCode.terminalMissing(error)) {
                if let owner { releaseAction(key, owner: owner) }
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
        var blockedOnly = true
        var failureReason = String(localized: "연결이나 초안이 바뀌어 보내지 않았습니다. 글을 확인하고 다시 보내 주세요.")
        defer {
            // A persisted refusal already explains the failure. Every other false result also
            // gets a composer-scoped explanation, including early guards and local errors.
            // 끝난 글의 안내는 끝난 자리에서 지운다. 접수 뒤에는 잠금이 풀려, 여기 올 때의 안내는 같은 입력칸의
            // 다음 전송이 쓴 것일 수 있다.
            if explainedFailure { messageSendNotices.removeValue(forKey: noticeKey) }
            else if !completed { messageSendNotices[noticeKey] = SendNotice(text: failureReason, whileBlocked: blockedOnly) }
        }
        guard canWrite else { failureReason = writeBlockedReason ?? String(localized: "최신 상태를 확인한 뒤 보내 주세요."); return false }
        guard let projectID = selectedProjectID else { failureReason = String(localized: "프로젝트를 고른 뒤 보내 주세요."); return false }
        guard let submissions else { failureReason = String(localized: "전송 기록을 준비하지 못했습니다. 다시 연결해 주세요."); return false }
        guard !isSending(projectID: projectID, targetMemberID: targetMemberID) else {
            failureReason = String(localized: "앞선 글을 보내는 중입니다. 끝난 뒤 다시 보내 주세요."); return false
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty else {
            failureReason = String(localized: "보낼 글이나 첨부를 넣어 주세요."); return false
        }
        let epoch = generation
        let actionKey = sendActionKey(projectID: projectID, targetMemberID: targetMemberID)
        let actionOwner = holdAction(actionKey)
        defer { if epoch == generation { releaseAction(actionKey, owner: actionOwner) } }
        blockedOnly = false
        let key = DraftStore.key(project: projectID, target: targetMemberID)
        do {
            // Query unresolved attempts before considering any edited replacement.
            for attempt in submissions.messages(namespace: writeNamespace) where attempt.draft.key == key
                && (attempt.status == .checking || (attempt.status == .accepted && !attempt.draftConsumed)) {
                if attempt.status == .checking, strictWriteContract {
                    failureReason = String(localized: "접수 확인 중입니다. 결과를 확인한 뒤 다시 보내 주세요.")
                    guard await reconcileMessage(attempt.id), epoch == generation else { return false }
                    if let current = submissions.messageAttempt(id: attempt.id), current.restoredDraft != nil {
                        failureReason = String(localized: "접수 확인 뒤 입력칸의 글이 바뀌었습니다. 확인하고 다시 보내 주세요.")
                        guard drafts.text(for: key) == text, drafts.files(for: key).map(\.id) == attachmentIDs else { return false }
                    }
                }
                if let current = submissions.messageAttempt(id: attempt.id), current.status == .accepted,
                   current.draft.text == text, current.request.attachmentIds == attachmentIDs {
                    try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                    completed = true; messageSendNotices.removeValue(forKey: noticeKey)
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
                throw APIError(status: 0, message: String(localized: "첨부 초안을 확인해 주세요. 누락된 첨부를 빼고 보내지 않습니다."))
            }
            if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
            let attempt = try retry ?? submissions.prepareMessage(projectID: projectID, targetMemberID: targetMemberID, draft: drafts.snapshot(for: key), contextFileID: contextFileID, clearsDraft: true)
            // No suspension between the durable intent, snapshot and durable clear. Both platforms share this path.
            let detached = try submissions.detachMessage(id: attempt.id, drafts: drafts)
            if retry == nil, attempt.handoffID != nil, !detached {
                throw APIError(status: 0, message: String(localized: "초안이 바뀌어 보내지 않았습니다. 입력칸을 확인하고 다시 보내 주세요."))
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
                try submissions.refuseMessage(id: attempt.id, reason: outcome.error?.localizedDescription ?? String(localized: "서버가 접수하지 않았습니다"))
                try submissions.restoreMessage(id: attempt.id, drafts: drafts)
                explainedFailure = true
                return false
            }
            guard epoch == generation else { return false }
            if let message = outcome.value {
                try submissions.acceptMessage(id: attempt.id, message: message)
                receiveHistoryMessage(message)
                try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                completed = true; messageSendNotices.removeValue(forKey: noticeKey)
                // 서버가 받았고 입력칸도 비웠다. 새로고침이 끝나기 전에도 다음 글을 보낼 수 있게 잠금을 푼다.
                releaseAction(actionKey, owner: actionOwner)
                await refresh()
                return true
            }
            if outcome.error != nil {
                failureReason = String(localized: "접수 확인 중입니다. 같은 전송 ID로 조회합니다.")
                errorMessage = failureReason
            } else { failureReason = errorMessage ?? failureReason }
        } catch {
            guard epoch == generation else { return false }
            if case SubmissionError.unresolvedAttempt = error {
                failureReason = String(localized: "이전 글의 접수 결과를 먼저 확인해 주세요. 글은 입력칸에 남아 있습니다.")
                errorMessage = failureReason
            } else { failureReason = error.localizedDescription; handle(error) }
        }
        return false
    }

    /// Explicit retry sends the retained immutable attempt and never detaches the user's next draft.
    @discardableResult func retryFailedMessage(id: String) async -> Bool {
        guard let attempt = submissions?.messageAttempt(id: id) else {
            explainMessageSendBlock(String(localized: "보내지 못한 글의 기록을 찾지 못했습니다."), targetMemberID: nil, whileBlocked: false)
            return false
        }
        let noticeKey = Self.scoped(attempt.namespace, attempt.draft.key)
        messageSendNotices.removeValue(forKey: noticeKey)
        var completed = false
        var blockedOnly = true
        var failureReason = String(localized: "지금은 다시 보낼 수 없습니다. 연결과 이전 전송 결과를 확인해 주세요.")
        defer {
            // 끝난 글의 안내는 끝난 자리에서 지운다(sendMessage와 같다).
            if !completed { messageSendNotices[noticeKey] = SendNotice(text: failureReason, whileBlocked: blockedOnly) }
        }
        guard canWrite, let submissions, let attempt = submissions.messageAttempt(id: id),
              attempt.namespace == writeNamespace, attempt.projectID == selectedProjectID,
              attempt.retainsFailedMessage,
              attempt.status == .refused || attempt.status == .notAccepted,
              !isSending(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID) else { return false }
        let epoch = generation
        let actionKey = sendActionKey(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID)
        let actionOwner = holdAction(actionKey)
        defer { if epoch == generation { releaseAction(actionKey, owner: actionOwner) } }
        blockedOnly = false
        do {
            let outcome: (value: Message?, error: Error?) = await perform(actionKey, refreshAfter: false,
                deferRefusalToReceipt: true, ownsPendingAction: true) { api in
                let request = try submissions.beginMessage(id: id)
                return try await api.sendMessage(projectID: attempt.projectID, request: request,
                                                 contractVersion: strictWriteContract ? 2 : nil)
            }
            if Self.definiteRefusal(outcome.error) {
                try submissions.refuseMessage(id: id, reason: outcome.error?.localizedDescription)
                // The retained failure notice explains this definitive rejection.
                completed = true; messageSendNotices.removeValue(forKey: noticeKey)
                return false
            }
            guard epoch == generation else { return false }
            if let message = outcome.value {
                try submissions.acceptMessage(id: id, message: message)
                receiveHistoryMessage(message)
                try submissions.consumeAccepted(id: id, drafts: drafts)
                completed = true; messageSendNotices.removeValue(forKey: noticeKey)
                releaseAction(actionKey, owner: actionOwner)
                await refresh()
                return true
            }
            failureReason = outcome.error == nil ? (errorMessage ?? failureReason) : String(localized: "접수 확인 중입니다. 같은 전송 ID로 조회합니다.")
        } catch {
            failureReason = error.localizedDescription
            if epoch == generation { handle(error) }
        }
        return false
    }

    func reconcileMessage(_ id: String) async -> Bool {
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
            if let attempt = submissions.messageAttempt(id: id), attempt.status == .accepted || attempt.status == .notAccepted {
                // 결과가 확정됐다. '접수 확인 중' 안내를 입력칸 아래와 위쪽 오류 줄에 남기지 않는다.
                messageSendNotices.removeValue(forKey: Self.scoped(attempt.namespace, attempt.draft.key))
                // 영어 화면의 같은 안내도 같은 머리로 시작한다(Localizable.xcstrings 의 번역이 지킨다).
                if let raw = rawErrorMessage, raw.hasPrefix("접수 확인 중입니다") || raw.hasPrefix(String(localized: "접수 확인 중입니다")) {
                    errorMessage = nil
                }
            }
            return true
        } catch {
            guard epoch == generation else { return false }
            handle(error)
            if canWrite {
                // A missing lookup endpoint, malformed response or transport failure is not
                // proof of absence. Keep the immutable attempt and make the pending result explicit.
                errorMessage = String(localized: "접수 확인 중입니다. 같은 전송 ID로 조회합니다. (\(error.localizedDescription))")
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
        await answerUsageLimit(decision, choice: UsageLimitInfo.resumeChoice)
    }

    /// Answers a usage-limit card: `resume`, or `model:<value>` (the server switches the card's staff to that model and continues the same sessions).
    @discardableResult func answerUsageLimit(_ decision: Decision, choice: String) async -> Bool {
        guard decision.kind == "usage_limit", decision.status == "open", UsageLimitInfo.accepts(decision, choice: choice) else { return false }
        if choice.hasPrefix(UsageLimitInfo.modelChoicePrefix) {
            // The server answers a model choice after closing, stopping and reopening each staff member in turn: give it the member-settings
            // time (150 s) instead of the 20 s default. Send the staff shown on this card so the server refuses (409) if someone joined since.
            return await answerDecision(decision, choice: choice, note: nil, memberIds: decision.usageLimit?.memberIds ?? [], timeout: 150)
        }
        return await answerDecision(decision, choice: choice, note: nil)
    }

    @discardableResult func answerDecision(_ decision: Decision, choice: String?, note: String?, memberIds: [String]? = nil, timeout: TimeInterval? = nil) async -> Bool {
        let req = AnswerRequest(choice: choice, note: note, batch: false, expectedVersion: decision.updatedAt, memberIds: memberIds)
        let result: Decision? = await mutate("decision:\(decision.id)") { api in
            try await api.send("/api/decisions/\(APIClient.segment(decision.id))/answer", body: req, timeout: timeout, contractVersion: strictWriteContract ? 2 : nil)
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
        await sleepMemberOutcome(member, force: force).ok
    }
    /// 재우기와 서버의 거절(코드 포함). 화면은 그 코드로 '그래도 재우기'를 띄울지 고른다(ServerCode.sleepForceable).
    func sleepMemberOutcome(_ member: Member, force: Bool = false) async -> (ok: Bool, refusal: APIError?) {
        struct Request: Encodable, Sendable { let force: Bool }
        let result: (value: Member?, error: Error?) = await perform("member:\(member.id)") { api in
            try await api.send("/api/members/\(APIClient.segment(member.id))/sleep", body: Request(force: force), timeout: 150)
        }
        return (result.value != nil, result.error as? APIError)
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

    /// Every pairing link or QR comes in here. A link opened from outside the app always waits for a yes; a QR the
    /// owner scanned inside the app waits only when it would replace a Mac that is already connected or saved.
    func receivePairingLink(_ link: PairingLink, device: String, external: Bool) async {
        guard !isDemo else { errorMessage = String(localized: "샘플 모드에서는 연결하지 않습니다."); return }
        let current = currentServerEndpoint
        let replaces = PairingRequest.replaces(currentEndpoint: current, serverAddresses: current.map { serverAddresses(for: $0) } ?? [], link: link)
        if external || replaces {
            holdPairingRequest(PairingRequest(link: link, device: device, replacesCurrent: replaces))
            return
        }
        await pair(with: link, device: device)
    }

    /// The request the owner read and confirmed (the one on screen, even if the dialog already cleared the pending one).
    @discardableResult func confirmPairing(_ request: PairingRequest) async -> Bool {
        if pairingRequest?.id == request.id { holdPairingRequest(nil) }
        guard !request.isExpired() else { errorMessage = PairingRequest.expiredMessage; return false }
        return await pair(with: request.link, device: request.device)
    }

    /// With a request: only that one is dropped, so a dialog closing late cannot cancel a newer link.
    func cancelPairing(_ request: PairingRequest? = nil) {
        if let request, pairingRequest?.id != request.id { return }
        holdPairingRequest(nil)
    }

    /// Sets the pending request and its end: a request nobody answers is dropped when the one-time code has run out,
    /// with a line saying so, instead of staying behind.
    private func holdPairingRequest(_ request: PairingRequest?) {
        pairingExpiryTask?.cancel(); pairingExpiryTask = nil
        pairingRequest = request
        guard let request else { return }
        pairingExpiryTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: PairingRequest.lifetime) } catch { return }
            guard let self, !Task.isCancelled, pairingRequest?.id == request.id else { return }
            pairingExpiryTask = nil; pairingRequest = nil
            errorMessage = PairingRequest.expiredMessage
        }
    }

    /// The Mac this app is connected to, or the saved one it is still trying to reach.
    private var currentServerEndpoint: String? {
        if let connected = connectedCredentials?.endpoint { return connected }
        return restoredCredentials && !accessCode.isEmpty ? endpoint : nil
    }

    // The addresses a server reports are kept with its saved connection, so a new QR from the same Mac is still
    // recognised while that Mac cannot be reached (a changed access code, the usual reason to scan again).
    private static let serverAddressesPrefix = "iamceo.serverAddresses.v1."
    private static func serverAddressesKey(_ endpoint: String) -> String? {
        (try? ServerEndpoint(endpoint)).map { serverAddressesPrefix + DraftStore.endpointNamespace($0) }
    }
    private func serverAddresses(for endpoint: String) -> [String] {
        let saved = Self.serverAddressesKey(endpoint).flatMap { navigationDefaults?.stringArray(forKey: $0) } ?? []
        return (connectedCredentials?.endpoint == endpoint ? bootstrap?.urls ?? [] : []) + saved
    }
    private func rememberServerAddresses() {
        guard let navigationDefaults, let endpoint = connectedCredentials?.endpoint,
              let key = Self.serverAddressesKey(endpoint), let urls = bootstrap?.urls else { return }
        let addresses = Array(urls.prefix(16))
        guard navigationDefaults.stringArray(forKey: key) != addresses else { return }
        // One saved connection, one list: a Mac this app has moved away from is forgotten.
        for old in navigationDefaults.dictionaryRepresentation().keys where old.hasPrefix(Self.serverAddressesPrefix) && old != key {
            navigationDefaults.removeObject(forKey: old)
        }
        navigationDefaults.set(addresses, forKey: key)
    }
    private func forgetServerAddresses(for endpoint: String) {
        if let key = Self.serverAddressesKey(endpoint) { navigationDefaults?.removeObject(forKey: key) }
    }

    // The command a server reports for its own terminal (Bootstrap `cli`) is kept with the saved connection, so the
    // connection screen can show the right 'open' command while that server cannot be reached. One saved connection, one value.
    private static let serverCLIKey = "iamceo.serverCLI.v1"
    private func rememberServerCLI() {
        guard let navigationDefaults, let endpoint = connectedCredentials?.endpoint, let cli = bootstrap?.cli,
              let namespace = (try? ServerEndpoint(endpoint)).map(DraftStore.endpointNamespace) else { return }
        let value = [namespace, String(cli.prefix(1024))]
        guard navigationDefaults.stringArray(forKey: Self.serverCLIKey) != value else { return }
        navigationDefaults.set(value, forKey: Self.serverCLIKey)
    }
    private func forgetServerCLI() { navigationDefaults?.removeObject(forKey: Self.serverCLIKey) }
    /// The terminal command the server at `endpoint` reported the last time this app connected to it.
    func serverCLI(for endpoint: String) -> String? {
        if let connected = connectedCredentials?.endpoint, connected == endpoint, let cli = bootstrap?.cli { return cli }
        guard let saved = navigationDefaults?.stringArray(forKey: Self.serverCLIKey), saved.count == 2,
              let namespace = (try? ServerEndpoint(endpoint)).map(DraftStore.endpointNamespace), saved[0] == namespace else { return nil }
        return saved[1]
    }

    /// Phone: trades the QR's one-time code for the access code over Tailscale, then connects like a manual login.
    @discardableResult func pair(with link: PairingLink, device: String) async -> Bool {
        guard !isDemo else { errorMessage = String(localized: "샘플 모드에서는 연결하지 않습니다."); return false }
        guard !isPairing else { return false }
        errorMessage = nil
        isPairing = true
        defer { isPairing = false }
        let pairingEpoch = generation
        do {
            let result = try await PairingClient.claim(link, device: device, session: injectedSession, tailnetConnected: tailnetConnected)
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
        guard let api else { throw APIError(status: 0, message: String(localized: "연결한 뒤 자료를 열어 주세요.")) }
        let file = try await api.fileBody(id: id, forceRefresh: forceRefresh)
        guard stillCurrent(api, project: file.projectId) else { throw APIError(status: 0, message: String(localized: "현재 프로젝트의 자료를 선택해 주세요.")) }
        return file
    }

    // 화면이 서버에서 직접 받는 읽기는 받기 → 확인 → 반영 순서로 한다. 아래가 그 '확인'이다(한 곳에서만 정한다).
    // 요청을 보낸 연결(`api`)과 그때의 범위를 넘기면, 받은 것을 지금 화면에 반영해도 되는지 답한다.
    /// 연결만: 그 요청을 보낸 연결이 지금도 이 앱의 연결인가(다른 서버로 바꿨거나 다시 연결했으면 false).
    func stillCurrent(_ api: APIClient?) -> Bool { self.api === api }
    /// 연결과 프로젝트: 지금 고른 프로젝트도 `project`인가(다른 프로젝트의 자료가 섞여 보이지 않게).
    func stillCurrent(_ api: APIClient?, project: String?) -> Bool { self.api === api && selectedProjectID == project }
    /// 연결·프로젝트와 보관함 보기: 보관한 프로젝트를 보는지도 그때와 같은가.
    func stillCurrent(_ api: APIClient?, project: String?, archived: Bool) -> Bool {
        stillCurrent(api, project: project) && isArchive == archived
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
            errorMessage = String(localized: "최신 업무 상태를 확인한 뒤 변경하세요."); return false
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
            errorMessage = String(localized: "최신 업무 상태를 확인한 뒤 변경하세요."); return false
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
        var pending = pending
        pending.createdAt = wallClock()
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
        } else { errorMessage = String(localized: "업무 변경 결과 확인 중입니다.") }
        await refreshWriteContext()
        return false
    }
    /// `trustFolder`: the owner agreed in the app that this folder may run commands, so the server answers the CLI's own
    /// "trust this folder?" window. The key is only sent when true.
    @discardableResult func createProject(name: String, cwd: String, goal: String = "", provider: String = "claude", trustFolder: Bool = false) async -> Bool {
        let req = CreateProjectRequest(name: name, cwd: cwd, goal: goal, startConductor: true, chiefCli: provider, trustFolder: trustFolder ? true : nil)
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
        guard ["interrupt", "resume", "sleep", "compact", "fresh-session"].contains(action) else { errorMessage = String(localized: "지원하지 않는 팀원 조작입니다."); return false }
        if action == "fresh-session" { return await freshSession(member) }
        if action == "compact" { return await compactMember(member) }
        let result: Member? = await mutate("member:\(member.id)") { api in try await api.request("/api/members/\(APIClient.segment(member.id))/\(action)", method: "POST", timeout: 150) }
        return result != nil
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
            errorMessage = String(localized: "최신 팀원 설정을 확인한 뒤 변경하세요."); return false
        }
        let result = await mutate("member:\(member.id)") { api in
            try await api.patchMember(id: member.id, request: req, revision: revision)
        }
        return result != nil
    }

    // MARK: First-run permission choice

    /// True while a freshly installed server says nobody has chosen how sessions run commands yet. Older servers
    /// (no such field) and the sample never ask.
    var needsPermissionChoice: Bool {
        bootstrap?.settings.permissionAcknowledged == false && permissionChosenNamespace != writeNamespace
    }

    /// Right after connecting, on whichever device connects: true once per connection, so one window opens the
    /// choice. (Until it is made the server holds sessions back, and this device may be the only screen there is.)
    func takePermissionChoiceOffer() -> Bool {
        guard needsPermissionChoice, connectionStatus == .connected, permissionChoiceOffered != writeNamespace else { return false }
        permissionChoiceOffered = writeNamespace
        return true
    }

    /// The choice was closed by the app itself before the owner answered (to make room for a pairing confirmation):
    /// it may be offered again.
    func returnPermissionChoiceOffer() {
        if needsPermissionChoice { permissionChoiceOffered = nil }
    }

    /// The Mac app talking to the server on the same Mac. An iPhone, or a Mac reaching another Mac over Tailscale,
    /// talks about "the connected Mac" instead.
    var serverIsThisMac: Bool { Self.serverIsThisMac(endpoint: connectedCredentials?.endpoint ?? endpoint, onMac: isMac) }
    static func serverIsThisMac(endpoint: String, onMac: Bool) -> Bool { onMac && isLoopback(endpoint) }

    /// Sends the picked mode and "the owner has chosen" in one settings change (the existing settings route).
    @discardableResult func acknowledgePermission(mode: String) async -> Bool {
        guard needsPermissionChoice, canWrite, !pendingActions.contains("settings"), let current = bootstrap?.settings else { return false }
        let namespace = writeNamespace, epoch = generation
        if !strictWriteContract {
            // A server without revisions takes the whole settings object, as the settings screen sends it there.
            var whole = current
            whole.permissionMode = mode; whole.permissionAcknowledged = true
            let payload = whole
            let result: Settings? = await mutate("settings") { api in
                try await api.send("/api/settings", method: "PUT", body: payload)
            }
            guard epoch == generation, result != nil else { return false }
            permissionChosenNamespace = namespace
            return true
        }
        guard let revision = writeRevisions?.settings else {
            errorMessage = String(localized: "설정을 아직 읽지 못했습니다. 잠시 뒤 다시 눌러 주세요."); return false
        }
        let result = await perform("settings", refreshAfter: false) { api in
            try await api.patchSettings(request: SettingsPatchRequest(permissionMode: mode, permissionAcknowledged: true), revision: revision)
        }
        guard epoch == generation else { return false }
        guard let saved = result.value else { await refreshWriteContext(); return false }
        refreshTask?.cancel(); refreshGeneration = UUID()
        writeContextGeneration = UUID()
        if saved.revision >= (writeRevisions?.settings ?? 0) {
            bootstrap?.settings = saved.settings; reviewedSettings = saved.settings
            writeRevisions?.settings = saved.revision
        }
        // An untouched settings editor restarts from the new values. One with edits keeps its old revision, so its
        // save is refused and the owner reviews it against the new values (the existing conflict path).
        if let current = settingsEdit, Self.same(current.draft, current.base) { settingsEdit = nil }
        permissionChosenNamespace = namespace
        dirty.insert(.diagnostics)
        await refresh()
        return true
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
            // The whole object goes back. "Not chosen yet" is the server's to say, never the app's: only true is sent.
            var whole = settings
            if whole.permissionAcknowledged != true { whole.permissionAcknowledged = nil }
            let payload = whole
            let result: Settings? = await mutate("settings") { api in
                try await api.send("/api/settings", method: "PUT", body: payload)
            }
            return result != nil
        }
        if settingsEdit == nil { _ = beginSettingsEditing() }
        guard var edit = settingsEdit else { errorMessage = String(localized: "이 호스트의 설정 revision을 확인할 수 없습니다."); return false }
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
            errorMessage = String(localized: "최신 세션 세대를 확인한 뒤 변경하세요."); return false
        }
        let epoch = generation
        if let existing = journal.operations.values.first(where: {
            $0.namespace == writeNamespace && $0.memberID == member.id && $0.kind == .freshSession
                && ($0.status == .pending || $0.status == .unknown)
        }) {
            await reconcileOperation(existing)
            guard epoch == generation else { return false }
            // 방금 닫힌 옛 작업은 더 막지 않는다. 이번에 누른 것은 새 작업으로 나간다.
            if !expireStaleOperation(existing.id) { return operationResults[existing.id]?.status == .applied }
        }
        let tracked = TrackedOperation(id: UUID().uuidString, namespace: writeNamespace, memberID: member.id,
                                       kind: .freshSession, sessionGeneration: version.sessionGeneration, order: (journal.operations.values.map(\.order).max() ?? -1) + 1,
                                       createdAt: Date().timeIntervalSince1970)
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
        guard let projectID = selectedProjectID, state != nil else { return nil }
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
           let index = state?.messages.firstIndex(where: { $0.id.utf8.elementsEqual(message.id.utf8) }),
           state?.messages[index] != message {
            state?.messages[index] = message
        }
        for index in notificationMessages.indices where notificationMessages[index].id.utf8.elementsEqual(message.id.utf8)
            && notificationMessages[index].projectId.utf8.elementsEqual(message.projectId.utf8)
            && notificationMessages[index] != message {
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
    func mergingRecentMessageDelivery(_ snapshot: ProjectState?) -> ProjectState? {
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
        guard foreground, historyVisible, connectionStatus == .connected, let api,
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
        guard !isArchive, connectionStatus == .connected, let api, let projectID = selectedProjectID,
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
            errorMessage = String(localized: "이전 전달 작업의 결과를 먼저 확인해 주세요."); return false
        }
        if unresolved == nil && !unassignedDeliveries.contains(where: { $0.messageId == messageID }) {
            await loadUnassignedDeliveries()
        }
        guard epoch == generation, projectEpoch == projectGeneration, canWrite, !pendingActions.contains(key) else { return false }
        let item = unassignedDeliveries.first { $0.messageId == messageID }
        guard unresolved != nil || (item?.version == 0 && item?.allowedActions.contains(action) == true) else { return false }
        var tracked = unresolved ?? PendingUnassignedRecovery(id: UUID().uuidString, namespace: namespace,
            projectID: projectID, messageID: messageID, version: item!.version, action: action)
        tracked.createdAt = wallClock()
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
        guard !isArchive, connectionStatus == .connected, let api, let projectID = selectedProjectID,
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
            errorMessage = String(localized: "이전 전달 작업의 결과를 먼저 확인해 주세요."); return false
        }
        var tracked = previous.flatMap { $0.result == nil && !$0.refused ? $0 : nil }
            ?? PendingDeliveryRecovery(id: UUID().uuidString, namespace: namespace, projectID: projectID,
                                       memberID: memberID, deliveryID: deliveryID, version: version,
                                       action: action, acceptDuplicateRisk: acceptDuplicateRisk)
        tracked.createdAt = wallClock()
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
        guard foreground, let api, connectionStatus == .connected else { return }
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
    /// B 묶음: 보관한 프로젝트를 지운다. 성공하면 보관함 목록에서 빼고, 그 기록을 보고 있었으면 본사로 돌아간다.
    /// 서버가 지우기를 모르면(옛 서버의 405) 화면은 그대로 두고 까닭만 알린다. 응답을 잃으면 목록을 다시 읽어 결과를 본다(다시 보내지 않는다).
    @discardableResult func deleteArchivedProject(id: String) async -> Bool {
        guard !isDemo, foreground, !isRevalidating, connectionStatus == .connected, let api else {
            errorMessage = String(localized: "서버에 연결된 뒤에 프로젝트를 지울 수 있습니다."); return false
        }
        let key = "project:\(id)"
        guard !pendingActions.contains(key) else { return false }
        let epoch = generation
        pendingActions.insert(key)
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            _ = try await api.deleteProject(id: id)
            guard epoch == generation else { return false }
        } catch {
            guard epoch == generation else { return false }
            let status = (error as? APIError)?.status
            errorMessage = status == 405 ? String(localized: "서버가 옛 버전이라 프로젝트를 지울 수 없습니다. 서버를 업데이트한 뒤 다시 해 주세요.") : error.localizedDescription
            if status == 401 { handle(error) }
            if foreground { await loadArchivedProjects() }
            return false
        }
        archivedProjects.removeAll { $0.id == id }
        if selectedProjectID == id {
            state = nil; histories.invalidate(projectID: id)
            for item in routers { item.value?.resetForProjectChange() }
            if let next = projects.first(where: { $0.id == "hq" || $0.isHq }) ?? projects.first { await selectProject(id: next.id) }
            else { selectedProjectID = nil; isArchive = false; projectGeneration = UUID() }
        }
        projectNotice = String(localized: "프로젝트를 지웠습니다.")
        if foreground { await loadArchivedProjects() }
        return true
    }

    @discardableResult func patchProject(id: String, request: PatchProjectRequest) async -> Bool {
        guard !isDemo, foreground, !isRevalidating, connectionStatus == .connected, let api else {
            errorMessage = String(localized: "서버에 연결된 뒤에 프로젝트를 관리할 수 있습니다."); return false
        }
        let key = "project:\(id)", journalKey = Self.scoped(writeNamespace, id)
        guard !pendingActions.contains(key), journal.projectChanges?[journalKey] == nil else {
            errorMessage = String(localized: "이전 프로젝트 변경 결과를 먼저 확인해 주세요."); return false
        }
        guard !(request.archived == true && (id == "hq" || projects.first { $0.id == id }?.isHq == true)) else {
            errorMessage = String(localized: "본사는 보관할 수 없습니다."); return false
        }
        let epoch = generation
        var tracked = PendingProjectChange(namespace: writeNamespace, projectID: id, request: request)
        tracked.createdAt = wallClock()
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
                errorMessage = refused ? error.localizedDescription : String(localized: "프로젝트 변경 결과를 확인해 주세요. 요청은 다시 보내지 않았습니다.")
            }
            return false
        }
    }

    /// Reads only. Matching current metadata is observable; it is not an operation receipt.
    func recheckProject(id: String) async { await recheckProject(id: id, now: wallClock()) }
    private func recheckProject(id: String, now: Double) async {
        guard foreground, let api, connectionStatus == .connected else { return }
        let epoch = generation, phase = foregroundGeneration, key = Self.scoped(writeNamespace, id)
        guard let tracked = journal.projectChanges?[key] else { return }
        projectRechecks[key] = now
        // 예전 기록에는 시각이 없다. 처음 본 때부터 센다.
        if tracked.createdAt == nil { _ = try? saveJournal { $0.projectChanges?[key]?.createdAt = now } }
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
                projectRechecks[key] = nil
                projectResults[id] = .current
                await applyManagedProject(project)
            } else if now - (tracked.createdAt ?? now) >= Self.projectChangeLimit {
                // 요청 제한 시간(150초)을 한참 넘겨도 서버 상태가 요청과 다르면 반영되지 않은 것이다.
                // 계속 '확인 중'으로 두면 이 프로젝트의 모든 쓰기가 이 기기에서 막힌 채 남는다.
                try endProjectChange(id: id, key: key, notice: String(localized: "프로젝트 변경이 반영되지 않아 확인을 끝냈습니다. 필요하면 다시 시도해 주세요."))
            } else { projectResults[id] = .checking }
        } catch {
            guard epoch == generation, journal.projectChanges?[key]?.id == tracked.id else { return }
            projectResults[id] = .checking
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    /// 결과 확인을 그만두고 서버의 지금 상태를 그대로 쓴다. 요청은 다시 보내지 않는다.
    func discardProjectChange(id: String) {
        let key = Self.scoped(writeNamespace, id)
        guard journal.projectChanges?[key] != nil, !pendingActions.contains("project:\(id)") else { return }
        do { try endProjectChange(id: id, key: key, notice: nil) } catch { handle(error) }
    }

    private func endProjectChange(id: String, key: String, notice: String?) throws {
        try saveJournal { $0.projectChanges?.removeValue(forKey: key) }
        projectRechecks[key] = nil
        projectResults[id] = .refused
        if let notice { projectNotice = notice }
    }

    private static let projectChangeLimit: Double = 300

    func reconcileProjectChanges() async {
        let epoch = generation, phase = foregroundGeneration, namespace = writeNamespace, now = wallClock()
        for tracked in Array(journal.projectChanges?.values ?? Dictionary<String, PendingProjectChange>().values)
            where tracked.namespace == namespace && !pendingActions.contains("project:\(tracked.projectID)") {
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            projectResults[tracked.projectID] = .checking
            // 스냅샷마다 조회 두 번을 얹지 않는다. '결과 확인' 버튼과 변경 직후의 확인은 이 간격과 무관하다.
            if let last = projectRechecks[Self.scoped(namespace, tracked.projectID)], now - last < 10, now >= last { continue }
            await recheckProject(id: tracked.projectID, now: now)
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
            projectNotice = String(localized: "프로젝트를 보관했습니다.")
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
            errorMessage = String(localized: "현재 세션은 문맥 압축을 지원하지 않거나 사용할 수 없습니다."); return false
        }
        let key = "member:\(member.id)", trackedKey = Self.scoped(writeNamespace, member.id)
        guard !pendingActions.contains(key), journal.contextRequests?[trackedKey] == nil else {
            errorMessage = String(localized: "압축 결과 확인 중입니다. 다시 전송하지 않습니다."); return false
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
            if contextChecking.contains(member.id) { errorMessage = String(localized: "압축 결과 확인 중입니다. 다시 전송하지 않습니다.") }
            return false
        }
    }

    func reconcileContextChanges() {
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

    private func resetReadCollections() {
        messageDeliveryUpdates = [:]
        cancelHistoryLoad(); histories.removeAll(); historyVisible = false; historyOwners = []; historyTarget = nil
        historyFlight = nil
        pagingSupport = .unknown; isArchive = false; archivedProjects = []; archiveError = nil
        archiveLoad = UUID(); isLoadingArchive = false; archiveObserved = false
        projectResults = [:]; projectNotice = nil; contextChecking = []
        deliveryPages = [:]; deliveryErrors = [:]; deliveryResults = [:]; deliveryChecking = []; deliveryFlights = [:]; deliveryRefreshPending = []
        openActivityMembers = []; activityWatchCounts = [:]; activityTokens = [:]; activityRevisions = [:]; activities = [:]; activityErrors = [:]
        activityEpoch &+= 1
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
        if base.permissionMode != draft.permissionMode {
            patch.permissionMode = draft.permissionMode
            // Picking a mode in settings is the same decision as the first-run choice: do not ask again.
            if base.permissionAcknowledged == false { patch.permissionAcknowledged = true }
        }
        if draft.permissionAcknowledged == true, base.permissionAcknowledged == false { patch.permissionAcknowledged = true }
        if base.maxConcurrentTurns != draft.maxConcurrentTurns { patch.maxConcurrentTurns = draft.maxConcurrentTurns }
        if base.compactAtPct != draft.compactAtPct { patch.compactAtPct = draft.compactAtPct }
        if base.contextWindowDefault != draft.contextWindowDefault { patch.contextWindowDefault = draft.contextWindowDefault }
        if base.contextWindows != draft.contextWindows { patch.contextWindows = draft.contextWindows }
        if base.maxAwakeWorkers != draft.maxAwakeWorkers { patch.maxAwakeWorkers = draft.maxAwakeWorkers }
        if base.notifyMac != draft.notifyMac { patch.notifyMac = draft.notifyMac }
        if base.boardTidyHours != draft.boardTidyHours { patch.boardTidyHours = draft.boardTidyHours }
        // An older server has no such setting (nil); never send it there, the strict schema would refuse the whole save.
        if base.reportLanguage != nil, base.reportLanguage != draft.reportLanguage { patch.reportLanguage = draft.reportLanguage }
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

// Folder picker / GitHub import only. Demo browsing never reaches a server.
extension AppStore {
    var recentProjectParent: String? {
        guard let project = projects.last(where: { !$0.isHq && !$0.cwd.isEmpty }) else { return nil }
        return ServerFolderPaths.parent(project.cwd)
    }
    func folderBrowser() async throws -> FolderBrowserResult {
        if isDemo { return .listing(try demoFolderContents(path: nil)) }
        guard let api else { throw APIError(status: 0, message: String(localized: "서버에 연결해 주세요.")) }
        return try await api.folderBrowser()
    }
    func folderContents(path: String) async throws -> FolderListing {
        if isDemo { return try demoFolderContents(path: path) }
        guard let api else { throw APIError(status: 0, message: String(localized: "서버에 연결해 주세요.")) }
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
        guard !isDemo, canWrite, let api else { throw APIError(status: 0, message: String(localized: "폴더 만들기는 연결된 서버에서만 할 수 있습니다.")) }
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
        guard let api else { throw APIError(status: 0, message: String(localized: "서버에 연결해 주세요.")) }
        return try await api.githubRepositories()
    }
    func startRepositoryClone(repo: String, parent: String) async throws -> String {
        guard !isDemo, canWrite, let api else { throw APIError(status: 0, message: String(localized: "가져오기는 연결된 서버에서만 할 수 있습니다.")) }
        return try await api.cloneRepository(repo: repo, parent: parent)
    }
    func repositoryCloneJob(_ id: String) async throws -> GitHubCloneJob {
        guard !isDemo, let api else { throw APIError(status: 0, message: String(localized: "서버에 연결해 주세요.")) }
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
