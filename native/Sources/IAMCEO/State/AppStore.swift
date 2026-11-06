import Foundation
import Observation

enum ConnectionStatus: String, Sendable { case disconnected, connecting, connected, demo, failed }

@MainActor @Observable
final class AppStore {
    var endpoint: String
    var accessCode: String
    private(set) var connectionStatus: ConnectionStatus = .disconnected
    var errorMessage: String?
    private(set) var isLoading = false
    /// A QR pairing claim is in flight (phone).
    private(set) var isPairing = false
    private(set) var pendingActions: Set<String> = []
    private(set) var terminalLeases: [String: TerminalLease] = [:]
    private(set) var bootstrap: Bootstrap?
    private(set) var runtime: RuntimeDiagnostics?
    private(set) var selectedProjectID: String?
    private(set) var state: ProjectState?
    private(set) var lastUpdated: Date?
    private(set) var api: APIClient?
    let isDemo: Bool
    var projects: [ProjectSummary] { bootstrap?.projects ?? [] }
    var messages: [Message] { state?.messages ?? [] }
    var members: [Member] { state?.members ?? [] }
    var decisions: [Decision] { state?.decisions ?? [] }
    var todos: [Todo] { state?.todos ?? [] }
    var files: [FileDoc] { state?.files ?? [] }
    var work: [WorkItem] { state?.work ?? [] }
    var canWrite: Bool { connectionStatus == .connected && !isDemo }
    /// The server stopped answering after a successful connect. The last snapshot stays on screen (read-only),
    /// polling keeps retrying, and the next successful refresh returns to `.connected`.
    var connectionLost: Bool { connectionStatus == .disconnected && api != nil && bootstrap != nil && !isDemo }
    /// Why the last sync failed while `connectionLost` (system wording, e.g. no internet vs. server not answering).
    private(set) var connectionIssue: String?
    var syncDescription: String { isDemo ? "Sample workspace · read-only" : foreground ? "Refreshes every 3 seconds while active" : "Updates paused in background" }
    @ObservationIgnored private let injectedSession: URLSession?
    @ObservationIgnored private let persistCredentials: Bool
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var projectGeneration = UUID()
    @ObservationIgnored private var refreshGeneration = UUID()
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<ProjectState, Error>?
    @ObservationIgnored private var refreshTask: Task<RefreshSnapshot, Error>?
    @ObservationIgnored private var foreground = true
    let drafts: DraftStore
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

    init(demo: Bool = false, session: URLSession? = nil, persistCredentials: Bool = true,
         drafts: DraftStore? = nil, submissions: SubmissionStore? = nil, writeStorageURL: URL? = nil) {
        injectedSession = session
        self.persistCredentials = persistCredentials
        isDemo = demo
        self.drafts = drafts ?? DraftStore(persist: persistCredentials && !demo)
        writeStorage = LocalStateStorage(enabled: !demo && (persistCredentials || writeStorageURL != nil),
                                         url: writeStorageURL, defaults: .standard, key: "iamceo.appWrites.v1")
        do {
            let restored = try writeStorage.read(AppWriteJournal.self) ?? AppWriteJournal()
            self.submissions = try submissions ?? SubmissionStore(persist: persistCredentials && !demo)
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
        let savedEndpoint = persistCredentials ? (UserDefaults.standard.string(forKey: "iamceo.endpoint") ?? defaultEndpoint) : defaultEndpoint
        endpoint = savedEndpoint
        accessCode = persistCredentials ? (KeychainStore.accessCode(for: savedEndpoint) ?? "") : ""
        if demo {
            let fixture = DemoFixtures.workspace()
            bootstrap = fixture.0
            state = fixture.1
            selectedProjectID = fixture.1.project.id
            connectionStatus = .demo
        }
    }

    func connect() async {
        guard !isDemo else { return }
        // "다시 연결" from the offline strip: same server and code, so retry now and keep the last snapshot,
        // leases and pending retries instead of dropping the CEO back onto the connection screen.
        if connectionLost, let creds = connectedCredentials,
           creds.endpoint == endpoint, creds.code == accessCode.trimmingCharacters(in: .whitespacesAndNewlines) {
            await refresh()
            return
        }
        releaseAllTerminals()
        stopRequests()
        generation = UUID()
        drafts.selectNamespace("unassigned")
        writeRevisions = nil; reviewedSettings = nil; reviewedMembers = [:]; reviewedTodos = [:]
        settingsEdit = nil; settingsConflict = nil; todoWrites = [:]; operationResults = [:]; batchResults = [:]
        leaseReceiptOrder = [:]; absentOperations = []; writeContextGeneration = UUID()
        strictWriteContract = false
        let epoch = generation
        lastReadError = nil
        connectionStatus = .connecting
        api = nil
        connectedCredentials = nil; transportFailures = 0; connectionIssue = nil
        pendingActions.removeAll()
        errorMessage = nil
        bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
        isLoading = true
        defer { if epoch == generation { isLoading = false } }
        do {
            let validated = try ServerEndpoint(endpoint)
            guard !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(status: 0, message: "접속 코드를 넣어 주세요.") }
            let client = APIClient(endpoint: validated, accessCode: accessCode.trimmingCharacters(in: .whitespacesAndNewlines), session: injectedSession)
            let initial: Bootstrap = try await client.request("/api/bootstrap")
            guard epoch == generation else { return }
            api = client
            writeNamespace = DraftStore.endpointNamespace(validated)
            drafts.selectNamespace(writeNamespace)
            bootstrap = initial
            runtime = initial.runtime
            endpoint = validated.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if persistCredentials { UserDefaults.standard.set(endpoint, forKey: "iamceo.endpoint") }
            do { if persistCredentials { try KeychainStore.save(accessCode, for: endpoint) } }
            catch { errorMessage = error.localizedDescription }
            connectedCredentials = (endpoint, accessCode.trimmingCharacters(in: .whitespacesAndNewlines))
            connectionStatus = .connected
            if let first = initial.projects.first { await selectProject(id: first.id) }
            else { await refreshWriteContext() }
            guard epoch == generation else { return }
            if runtime == nil {
                do { runtime = try await client.request("/api/runtime") }
                catch { if let apiError = error as? APIError, apiError.status == 401 { handle(error) } }
            }
            await recoverWrites()
            guard epoch == generation, canWrite else { return }
            startPolling()
        } catch {
            guard epoch == generation else { return }
            api = nil
            connectionStatus = .failed
            errorMessage = error.localizedDescription
        }
    }

    func disconnect() {
        releaseAllTerminals()
        stopRequests()
        generation = UUID(); projectGeneration = UUID()
        if persistCredentials { KeychainStore.remove(for: endpoint) }
        api = nil; accessCode = ""; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
        connectedCredentials = nil; transportFailures = 0; connectionIssue = nil
        connectionStatus = .disconnected
        drafts.selectNamespace("unassigned"); writeNamespace = "unassigned"
        writeRevisions = nil; settingsEdit = nil; settingsConflict = nil
        todoWrites = [:]; operationResults = [:]; batchResults = [:]
        pendingActions.removeAll(); terminalLeases.removeAll(); isLoading = false; errorMessage = nil; lastUpdated = nil
    }

    func selectProject(id: String) async {
        if isDemo { return }
        guard let api, connectionStatus == .connected else { return }
        loadTask?.cancel()
        refreshTask?.cancel()
        projectGeneration = UUID()
        let projectEpoch = projectGeneration
        let epoch = generation
        selectedProjectID = id
        state = nil
        writeRevisions?.members = nil; writeRevisions?.todos = nil
        reviewedMembers = [:]; reviewedTodos = [:]
        errorMessage = nil
        isLoading = true
        let task = Task { try await api.request("/api/projects/\(APIClient.segment(id))/state") as ProjectState }
        loadTask = task
        defer { if projectEpoch == projectGeneration { isLoading = false } }
        do {
            let next = try await task.value
            guard epoch == generation, projectEpoch == projectGeneration, selectedProjectID == id else { return }
            state = next; lastUpdated = Date()
            markReachable()
            clearReadError()
            await refreshWriteContext()
        } catch {
            guard epoch == generation, projectEpoch == projectGeneration, !Task.isCancelled else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if markUnreachable(error) { return }
            handle(error)
            lastReadError = errorMessage
        }
    }

    func refresh() async {
        guard !isDemo, let api, connectionStatus == .connected || connectionLost, !isLoading else { return }
        let epoch = generation, projectEpoch = projectGeneration
        refreshGeneration = UUID()
        let refreshEpoch = refreshGeneration
        let projectID = selectedProjectID
        refreshTask?.cancel()
        let task = Task { () throws -> RefreshSnapshot in
            let nextBootstrap: Bootstrap = try await api.request("/api/bootstrap")
            let nextState: ProjectState?
            if let projectID, nextBootstrap.projects.contains(where: { $0.id == projectID }) {
                nextState = try await api.request("/api/projects/\(APIClient.segment(projectID))/state")
            } else { nextState = nil }
            return RefreshSnapshot(bootstrap: nextBootstrap, state: nextState)
        }
        refreshTask = task
        do {
            let snapshot = try await task.value
            guard epoch == generation, projectEpoch == projectGeneration, refreshEpoch == refreshGeneration else { return }
            markReachable()
            bootstrap = snapshot.bootstrap
            if let diagnostics = snapshot.bootstrap.runtime { runtime = diagnostics }
            if let projectID, !snapshot.bootstrap.projects.contains(where: { $0.id == projectID }) {
                state = nil; selectedProjectID = nil
                if let first = snapshot.bootstrap.projects.first { await selectProject(id: first.id) }
                return
            }
            state = snapshot.state
            lastUpdated = Date()
            clearReadError()
            await refreshWriteContext()
            await recoverWrites()
        } catch {
            guard epoch == generation, refreshEpoch == refreshGeneration else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if markUnreachable(error) { return }
            handle(error)
            lastReadError = errorMessage
        }
    }

    func setForeground(_ active: Bool) {
        foreground = active
        if active { startPolling() } else { pollTask?.cancel(); pollTask = nil }
    }
    private func startPolling() {
        pollTask?.cancel()
        guard foreground, connectionStatus == .connected || connectionLost else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                // Keep polling while the connection is lost so the desk comes back by itself.
                guard let self, !Task.isCancelled, self.foreground, self.connectionStatus == .connected || self.connectionLost else { return }
                await self.refresh()
            }
        }
    }
    /// Transport failures (no network, host unreachable, timeout, or Tailscale Serve's 502–504 while the daemon is down)
    /// move to the offline state instead of pretending the connection is healthy. Returns whether it handled `error`.
    private func markUnreachable(_ error: Error) -> Bool {
        let code = (error as? URLError)?.code
        let transport: Set<URLError.Code> = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
                                              .dnsLookupFailed, .timedOut, .internationalRoamingOff, .dataNotAllowed, .callIsActive]
        let gateway = [502, 503, 504].contains((error as? APIError)?.status ?? 0)
        guard api != nil, bootstrap != nil, gateway || code.map(transport.contains) == true else { return false }
        transportFailures += 1
        connectionIssue = error.localizedDescription
        if lastReadError != nil { clearReadError() }
        // A stale socket after iOS returns from background fails once with "connection lost"; only a repeat counts.
        guard connectionStatus == .connected, code != .networkConnectionLost || transportFailures >= 2 else { return true }
        connectionStatus = .disconnected
        return true
    }
    private func markReachable() {
        transportFailures = 0
        connectionIssue = nil
        if connectionLost { connectionStatus = .connected }
    }
    private func stopRequests() { pollTask?.cancel(); pollTask = nil; loadTask?.cancel(); loadTask = nil; refreshTask?.cancel(); refreshTask = nil }
    private func clearReadError() {
        if let lastReadError, errorMessage == lastReadError { errorMessage = nil }
        lastReadError = nil
    }
    private func handle(_ error: Error) {
        errorMessage = error.localizedDescription
        if (error as? APIError)?.status == 401 {
            stopRequests(); generation = UUID(); projectGeneration = UUID()
            api = nil; bootstrap = nil; state = nil; runtime = nil; selectedProjectID = nil
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
    private func perform<T: Sendable>(_ key: String, refreshAfter: Bool = true, operation: (APIClient) async throws -> T) async -> (value: T?, error: Error?) {
        guard !isDemo else { errorMessage = "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 바꿀 수 있습니다."; return (nil, nil) }
        guard let api, canWrite else { errorMessage = "서버에 연결된 뒤에 바꿀 수 있습니다."; return (nil, nil) }
        guard !pendingActions.contains(key) else { return (nil, nil) }
        let epoch = generation
        pendingActions.insert(key); errorMessage = nil
        defer { if epoch == generation { pendingActions.remove(key) } }
        do {
            let result = try await operation(api)
            guard epoch == generation else { return (nil, nil) }
            if refreshAfter { await refresh() }
            guard epoch == generation else { return (nil, nil) }
            return (result, nil)
        } catch {
            guard epoch == generation else { return (nil, error) }
            handle(error)
            // A conflict means our copy is stale (answered elsewhere, closed, reopened): show the truth right away.
            if (error as? APIError)?.status == 409 {
                pendingActions.remove(key)
                await refresh()
            }
            return (nil, error)
        }
    }

    /// The caller may pass the shared composer DraftStore. The immutable snapshot is durable before POST.
    @discardableResult func sendMessage(text: String, targetMemberID: String? = nil, attachmentIDs: [String] = []) async -> Bool {
        guard !isDemo else { errorMessage = "샘플은 읽기 전용입니다."; return false }
        guard canWrite, let projectID = selectedProjectID, let submissions,
              !pendingActions.contains("send:\(projectID)"),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty else { return false }
        let epoch = generation
        let key = DraftStore.key(project: projectID, target: targetMemberID)
        do {
            // Query unresolved attempts before considering any edited replacement.
            for attempt in submissions.messages(namespace: writeNamespace) where attempt.draft.key == key
                && (attempt.status == .checking || (attempt.status == .accepted && !attempt.draftConsumed)) {
                if attempt.status == .checking, strictWriteContract {
                    guard await reconcileMessage(attempt.id), epoch == generation else { return false }
                }
                if let current = submissions.messageAttempt(id: attempt.id), current.status == .accepted,
                   current.draft.text == text, current.request.attachmentIds == attachmentIDs {
                    try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                    return true
                }
            }
            drafts.setText(text, for: key)
            let files = drafts.files(for: key)
            guard Set(files.map(\.id)) == Set(attachmentIDs), files.count == attachmentIDs.count else {
                throw APIError(status: 0, message: "첨부 초안을 확인해 주세요. 누락된 첨부를 빼고 보내지 않습니다.")
            }
            if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
            let attempt = try submissions.prepareMessage(projectID: projectID, targetMemberID: targetMemberID, draft: drafts.snapshot(for: key))
            let outcome: (value: Message?, error: Error?) = await perform("send:\(projectID)", refreshAfter: false) { api in
                let request = try submissions.beginMessage(id: attempt.id, allowUnconfirmedRetry: !strictWriteContract)
                return try await api.send("/api/projects/\(APIClient.segment(projectID))/messages", body: request, contractVersion: strictWriteContract ? 2 : nil)
            }
            guard epoch == generation else { return false }
            if let message = outcome.value {
                try submissions.acceptMessage(id: attempt.id, message: message)
                try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
                await refresh()
                return true
            }
            if Self.definiteRefusal(outcome.error) { try submissions.refuseMessage(id: attempt.id) }
            else if outcome.error != nil { errorMessage = "접수 확인 중입니다. 같은 전송 ID로 조회합니다." }
        } catch {
            guard epoch == generation else { return false }
            handle(error)
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
                try submissions.consumeAccepted(id: id, drafts: drafts)
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
            guard epoch == generation, canWrite,
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
        guard let projectID = selectedProjectID, message.mine, message.delivery == "failed" else { return false }
        let request = SendMessageRequest(id: message.id, text: message.body, targetMemberId: message.targetMemberId, attachmentIds: message.attachments.map(\.id))
        let result: Message? = await mutate("send:\(projectID)") { api in
            try await api.send("/api/projects/\(APIClient.segment(projectID))/messages", body: request)
        }
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
        errorMessage = nil
        isPairing = true
        defer { isPairing = false }
        do {
            let result = try await PairingClient.claim(link, device: device, session: injectedSession)
            endpoint = result.endpoint
            accessCode = result.accessCode
            await connect()
            return connectionStatus == .connected
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult func setTodoDone(_ todo: Todo, done: Bool) async -> Bool {
        if !strictWriteContract {
            let result: Todo? = await mutate("todo:\(todo.id)") { api in
                try await api.send("/api/todos/\(APIClient.segment(todo.id))/done", body: TodoPatchRequest(done: done))
            }
            return result != nil
        }
        guard canWrite, let revision = writeRevisions?.todos?[todo.id],
              reviewedTodos[todo.id].map({ Self.same($0, todo) }) == true,
              todoWrites[todo.id] != .checking, todoWrites[todo.id] != .sending else {
            errorMessage = "최신 업무 상태를 확인한 뒤 변경하세요."; return false
        }
        let epoch = generation, namespace = writeNamespace
        do {
            try saveJournal { $0.todos[Self.scoped(namespace, todo.id)] = PendingTodo(id: todo.id, namespace: namespace, revision: revision, done: done) }
        } catch { handle(error); return false }
        todoWrites[todo.id] = .sending
        let outcome = await perform("todo:\(todo.id)", refreshAfter: false) { api in
            try await api.patchTodo(id: todo.id, request: TodoPatchRequest(done: done), revision: revision)
        }
        guard epoch == generation else { return false }
        if let result = outcome.value, result.todo.id == todo.id, result.todo.done == done, result.revision >= revision {
            todoWrites[todo.id] = .confirmed
            writeRevisions?.todos?[todo.id] = result.revision
            if let index = state?.todos.firstIndex(where: { $0.id == todo.id }) { state?.todos[index] = result.todo }
            do { try saveJournal { $0.todos.removeValue(forKey: Self.scoped(namespace, todo.id)) } }
            catch { handle(error) }
            await refresh()
            return true
        }
        todoWrites[todo.id] = Self.definiteRefusal(outcome.error) ? .conflict : .checking
        if todoWrites[todo.id] == .conflict {
            do { try saveJournal { $0.todos.removeValue(forKey: Self.scoped(namespace, todo.id)) } }
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
        // Invalidate reads that began before this CAS completed.
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
                                       kind: .freshSession, sessionGeneration: version.sessionGeneration, order: journal.operations.count)
        do { try saveJournal { $0.operations[tracked.id] = tracked } }
        catch { handle(error); return false }
        let result = await perform("member:\(member.id)", refreshAfter: false) { api in
            try await api.freshSession(memberID: member.id, request: FreshSessionRequest(operationId: tracked.id, expectedSessionGeneration: tracked.sessionGeneration))
        }
        guard epoch == generation else { return false }
        if let receipt = result.value {
            do { try applyReceipt(receipt, tracked: tracked) } catch { handle(error) }
        } else {
            await recordOperationFailure(tracked, error: result.error)
            await reconcileOperation(tracked)
        }
        if operationResults[tracked.id]?.status == .applied { await refresh(); return true }
        return false
    }

    @discardableResult func claimTerminal(_ member: Member) async -> Bool {
        if strictWriteContract { return await terminalOperation(member, action: .claim) }
        // Passing the lease we still hold renews it; a lost input reply may have extended it on the server past our copy.
        let known = terminalLeases[member.id]?.leaseId
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
    @discardableResult func releaseTerminal(_ member: Member) async -> Bool {
        if strictWriteContract {
            let success = await terminalOperation(member, action: .release)
            if !success, terminalLeases[member.id] != nil {
                errorMessage = "\(member.name)의 조작권을 놓지 못했습니다. 결과 확인 중이며 서버의 lease가 유지될 수 있습니다."
            }
            return success
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
                "Terminal has finished", "No core terminal for member"].contains { error.message.contains($0) }
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

    private func terminalOperation(_ member: Member, action: TerminalAction, text: String? = nil, key: TerminalKey? = nil) async -> Bool {
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
               let attempt = submissions.terminalAttempt(id: previous.id) {
                let result = await perform("terminal:\(member.id)", refreshAfter: false) { api in
                    try await api.terminalControl(memberID: member.id, request: attempt.request)
                }
                guard epoch == generation else { return false }
                if let receipt = result.value {
                    do { try applyReceipt(receipt, tracked: previous) } catch { handle(error) }
                }
                return operationResults[previous.id]?.status == .applied
            }
            // A repeated click observes the original input; it never becomes another physical write.
            if previous.action == action {
                let sent = submissions.terminalAttempt(id: previous.id)
                return operationResults[previous.id]?.status == .applied && sent?.input?.text == text && sent?.key == key
            }
            guard let status = operationResults[previous.id]?.status, status == .applied || status == .refused else {
                errorMessage = "직접 조작 결과 확인 중입니다. 미확인 입력을 다시 보내지 않습니다."; return false
            }
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
                                                         sessionGeneration: version.sessionGeneration, action: action, key: key)
            let tracked = TrackedOperation(id: attempt.id, namespace: writeNamespace, memberID: member.id,
                                           kind: .terminalControl, sessionGeneration: version.sessionGeneration,
                                           order: journal.operations.count, action: action)
            try saveJournal { $0.operations[tracked.id] = tracked }
            let result = await perform("terminal:\(member.id)", refreshAfter: false) { api in
                try await api.terminalControl(memberID: member.id, request: submissions.beginTerminal(id: attempt.id))
            }
            guard epoch == generation else { return false }
            if let receipt = result.value { try applyReceipt(receipt, tracked: tracked) }
            else {
                await recordOperationFailure(tracked, error: result.error)
                await reconcileOperation(tracked)
            }
            if operationResults[tracked.id]?.status == .applied { return true }
            if Self.leaseGone(result.error) { terminalLeases.removeValue(forKey: member.id) }
        } catch { if epoch == generation { handle(error) } }
        return false
    }

    /// Query-only recovery, also called after reconnect. No message or terminal write is replayed here.
    func recoverWrites() async {
        guard canWrite, strictWriteContract, !recoveryInFlight, let submissions else { return }
        recoveryInFlight = true
        defer { recoveryInFlight = false }
        let epoch = generation, namespace = writeNamespace
        for attempt in submissions.messages(namespace: namespace) where attempt.status == .checking || attempt.status == .accepted || attempt.status == .notAccepted {
            _ = await reconcileMessage(attempt.id)
            guard epoch == generation, canWrite else { return }
        }
        for operation in journal.operations.values.sorted(by: { $0.order < $1.order }) where operation.namespace == namespace {
            if operation.kind == .terminalControl || operation.status == .unknown || operation.status == .pending {
                await reconcileOperation(operation)
                guard epoch == generation, canWrite else { return }
            }
        }
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
        if journal.operations[tracked.id]?.status == .applied, receipt.status != .applied { return }
        if tracked.kind == .terminalControl {
            guard let submissions else { throw SubmissionError.invalidTransition }
            try submissions.applyTerminalReceipt(receipt)
            if receipt.status == .applied, case .terminalControl(let result) = receipt.result,
               writeRevisions?.members?[tracked.memberID]?.sessionGeneration == result.sessionGeneration,
               tracked.order >= (leaseReceiptOrder[tracked.memberID] ?? -1) {
                leaseReceiptOrder[tracked.memberID] = tracked.order
                if tracked.action == .release { terminalLeases.removeValue(forKey: tracked.memberID) }
                else if let lease = result.leaseId {
                    terminalLeases[tracked.memberID] = TerminalLease(leaseId: lease, expiresAt: result.expiresAt)
                }
            }
        } else if receipt.status == .applied {
            guard case .freshSession(let result) = receipt.result, result.member.id == tracked.memberID,
                  result.sessionGeneration > tracked.sessionGeneration else { throw SubmissionError.mismatchedResult }
        }
        try saveJournal { $0.operations[tracked.id]?.status = receipt.status }
        operationResults[tracked.id] = receipt
        if receipt.status == .unknown || receipt.status == .pending {
            errorMessage = "작업 결과 확인 중입니다. 미확인 작업은 재실행하지 않습니다."
        } else if receipt.status == .refused { errorMessage = receipt.error ?? "서버가 작업을 거부했습니다." }
    }

    private func recordOperationFailure(_ tracked: TrackedOperation, error: Error?) async {
        if journal.operations[tracked.id]?.status == .applied { return }
        let status: OperationStatus = Self.definiteRefusal(error) ? .refused : .unknown
        let receipt = OperationReceipt(operationId: tracked.id, kind: tracked.kind, memberId: tracked.memberID,
                                       status: status, code: (error as? APIError)?.code, error: error?.localizedDescription)
        do { try applyReceipt(receipt, tracked: tracked) } catch { handle(error) }
    }

    /// Revisions and reviewed values always come from the same atomic /sync response.
    private func refreshWriteContext() async {
        guard let api, canWrite else { return }
        let epoch = generation, projectEpoch = projectGeneration, projectID = selectedProjectID
        writeContextGeneration = UUID()
        let contextEpoch = writeContextGeneration
        do {
            let capabilities = try await api.capabilities()
            guard epoch == generation, projectEpoch == projectGeneration,
                  contextEpoch == writeContextGeneration else { return }
            // Once advertised, a failed probe/sync must never downgrade this connection's writes.
            if capabilities.contractVersion == 2, capabilities.capabilities?.operations == true {
                strictWriteContract = true
            }
        } catch {
            guard epoch == generation, projectEpoch == projectGeneration,
                  contextEpoch == writeContextGeneration else { return }
            if (error as? APIError)?.status == 401 { handle(error); return }
            // Optional capability discovery cannot disable an otherwise usable v1 connection.
        }
        guard strictWriteContract else { return }
        do {
            let snapshot = try await api.sync(projectID: projectID)
            guard epoch == generation, projectEpoch == projectGeneration,
                  contextEpoch == writeContextGeneration,
                  snapshot.requestedProjectId == projectID else { return }
            writeRevisions = snapshot.revisions
            reviewedSettings = snapshot.bootstrap.settings
            reviewedMembers = (snapshot.state?.members ?? []).reduce(into: [:]) { $0[$1.id] = $1 }
            reviewedTodos = (snapshot.state?.todos ?? []).reduce(into: [:]) { $0[$1.id] = $1 }
            if settingsEdit == nil { _ = beginSettingsEditing() }
            for pending in Array(journal.todos.values) where pending.namespace == writeNamespace {
                guard let revision = snapshot.revisions?.todos?[pending.id], let todo = reviewedTodos[pending.id] else { continue }
                if revision > pending.revision {
                    try saveJournal { $0.todos.removeValue(forKey: Self.scoped(pending.namespace, pending.id)) }
                    todoWrites[pending.id] = todo.done == pending.done ? .confirmedCurrent : .conflict
                } else { todoWrites[pending.id] = .checking }
            }
        } catch {
            // Capability/sync absence does not fail an otherwise usable legacy connection.
            guard epoch == generation, contextEpoch == writeContextGeneration else { return }
            if (error as? APIError)?.status == 401 { handle(error) }
        }
    }

    private func saveJournal(_ change: (inout AppWriteJournal) -> Void) throws {
        if let persistenceFailure { throw APIError(status: 0, message: persistenceFailure) }
        var next = journal
        change(&next)
        try writeStorage.write(next)
        journal = next
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
    var status: OperationStatus = .unknown
}
private struct PendingTodo: Codable {
    let id: String
    let namespace: String
    let revision: Int
    let done: Bool
}
private struct AppWriteJournal: Codable {
    var operations: [String: TrackedOperation] = [:]
    var todos: [String: PendingTodo] = [:]
}

private struct RefreshSnapshot: Sendable { let bootstrap: Bootstrap; let state: ProjectState? }
