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
    /// Keep the exact request ID across ambiguous network failures and user retries.
    @ObservationIgnored private var sendRetries: [String: SendMessageRequest] = [:]
    @ObservationIgnored private var lastReadError: String?
    /// Endpoint and code of the live client, so a reconnect from the offline strip can keep the last snapshot.
    @ObservationIgnored private var connectedCredentials: (endpoint: String, code: String)?
    @ObservationIgnored private var transportFailures = 0

    init(demo: Bool = false, session: URLSession? = nil, persistCredentials: Bool = true) {
        injectedSession = session
        self.persistCredentials = persistCredentials
        isDemo = demo
        // iPhone's 127.0.0.1 is the phone itself: start empty there so the Tailscale HTTPS placeholder shows.
        #if os(macOS)
        let defaultEndpoint = "http://127.0.0.1:7878"
        #else
        let defaultEndpoint = ""
        #endif
        let savedEndpoint = UserDefaults.standard.string(forKey: "iamceo.endpoint") ?? defaultEndpoint
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
            bootstrap = initial
            runtime = initial.runtime
            endpoint = validated.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if persistCredentials { UserDefaults.standard.set(endpoint, forKey: "iamceo.endpoint") }
            do { if persistCredentials { try KeychainStore.save(accessCode, for: endpoint) } }
            catch { errorMessage = error.localizedDescription }
            connectedCredentials = (endpoint, accessCode.trimmingCharacters(in: .whitespacesAndNewlines))
            connectionStatus = .connected
            if let first = initial.projects.first { await selectProject(id: first.id) }
            guard epoch == generation else { return }
            if runtime == nil {
                do { runtime = try await client.request("/api/runtime") }
                catch { if let apiError = error as? APIError, apiError.status == 401 { handle(error) } }
            }
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
        pendingActions.removeAll(); terminalLeases.removeAll(); sendRetries.removeAll(); isLoading = false; errorMessage = nil; lastUpdated = nil
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

    @discardableResult func sendMessage(text: String, targetMemberID: String? = nil, attachmentIDs: [String] = []) async -> Bool {
        guard let projectID = selectedProjectID, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty else { return false }
        let key = [projectID, targetMemberID ?? "", text, attachmentIDs.joined(separator: ",")].joined(separator: "\u{0}")
        let request = sendRetries[key] ?? SendMessageRequest(id: UUID().uuidString, text: text, targetMemberId: targetMemberID, attachmentIds: attachmentIDs)
        sendRetries[key] = request
        let result: Message? = await mutate("send:\(projectID)") { api in
            try await api.send("/api/projects/\(APIClient.segment(projectID))/messages", body: request)
        }
        if result != nil { sendRetries.removeValue(forKey: key) }
        return result != nil
    }
    @discardableResult func answerDecision(_ decision: Decision, choice: String?, note: String?) async -> Bool {
        let req = AnswerRequest(choice: choice, note: note, batch: false, expectedVersion: decision.updatedAt)
        let result: Decision? = await mutate("decision:\(decision.id)") { api in
            try await api.send("/api/decisions/\(APIClient.segment(decision.id))/answer", body: req)
        }
        return result != nil
    }
    /// Answers every card with the recommended option. Each request still carries its own reviewed version.
    func answerBatch(_ decisions: [Decision], notes: [String: String] = [:]) async -> (sent: Int, failures: [String]) {
        var sent = 0
        var failures: [String] = []
        for decision in decisions {
            guard let rec = decision.rec, decision.options.contains(where: { $0.k == rec }) else { continue }
            let note = notes[decision.id].flatMap { $0.isEmpty ? nil : $0 }
            let req = AnswerRequest(choice: rec, note: note, batch: true, expectedVersion: decision.updatedAt)
            let result: Decision? = await mutate("decision:\(decision.id)", refreshAfter: false) { api in
                try await api.send("/api/decisions/\(APIClient.segment(decision.id))/answer", body: req)
            }
            if result != nil { sent += 1 } else { failures.append(errorMessage ?? decision.title) }
        }
        await refresh()
        return (sent, failures)
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
        struct Request: Encodable, Sendable { let done: Bool }
        let result: Todo? = await mutate("todo:\(todo.id)") { api in try await api.send("/api/todos/\(APIClient.segment(todo.id))/done", body: Request(done: done)) }
        return result != nil
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
        let result: Member? = await mutate("member:\(member.id)") { api in try await api.request("/api/members/\(APIClient.segment(member.id))/\(action)", method: "POST", timeout: 150) }
        return result != nil
    }
    @discardableResult func patchMember(_ member: Member, provider: String, model: String?, effort: String?) async -> Bool {
        let req = PatchMemberRequest(cli: provider, modelOverride: model, effortOverride: effort)
        let result: Member? = await mutate("member:\(member.id)") { api in try await api.send("/api/members/\(APIClient.segment(member.id))", method: "PATCH", body: req, timeout: 150) }
        return result != nil
    }
    @discardableResult func updateSettings(_ settings: Settings) async -> Bool {
        let result: Settings? = await mutate("settings") { api in try await api.send("/api/settings", method: "PUT", body: settings) }
        if let result { bootstrap?.settings = result }
        return result != nil
    }
    @discardableResult func claimTerminal(_ member: Member) async -> Bool {
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
        await terminalControl(member, action: "input", text: text)
    }
    @discardableResult func terminalKey(_ member: Member, key: String) async -> Bool {
        guard ["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].contains(key) else { errorMessage = "지원하지 않는 키입니다."; return false }
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
        guard let api else { terminalLeases.removeAll(); return }
        let leases = terminalLeases
        terminalLeases.removeAll()
        Task {
            for (memberID, lease) in leases {
                guard let id = lease.leaseId else { continue }
                _ = try? await api.terminalControl(memberID: memberID, request: TerminalControlRequest(action: "release", leaseId: id))
            }
        }
    }

}

private struct RefreshSnapshot: Sendable { let bootstrap: Bootstrap; let state: ProjectState? }
