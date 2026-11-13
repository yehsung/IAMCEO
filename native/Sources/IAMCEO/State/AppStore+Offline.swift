import Foundation

// AppStore 의 F1(4차 S): 마지막으로 본 상태와 연결되면 보낼 글. 저장 형식과 파일 규칙은 OfflineState.swift.
// - 시작할 때 저장한 연결의 마지막 상태가 있으면 빈 연결 화면 대신 그것을 읽기 전용으로 띄우고, 연결은 평소대로 시도한다.
//   서버가 실제로 답해 새 상태가 화면에 들어오면 표지(lastSeen)를 내린다.
// - 서버가 확인해 준 상태는 30초에 한 번까지, 그리고 앱이 뒤로 갈 때 기기에 남긴다.
// - 연결되지 않은 동안 쓴 글은 '연결되면 보낼 글'로 둔다. 연결되면 오래된 것부터 하나씩 보낸다. 앞선 글이 접수되지
//   않았거나 결과를 모르면 다음 글은 보내지 않는다(결과를 모르는 글은 접수 확인이 같은 ID 로 조회한다. 다시 보내지 않는다).
extension AppStore {
    /// 마지막으로 본 상태를 몇 초 안에 새 상태로 바꾸지 못하면 그때 '마지막으로 본 상태' 줄을 띄운다(이 Mac 의 서버처럼
    /// 바로 붙는 연결에서 줄이 깜빡이지 않게). 연결이 실패하면 바로 띄운다.
    static let lastSeenNoticeDelay: Duration = .milliseconds(1500)
    /// 마지막 상태를 기기에 남기는 가장 짧은 간격.
    static let lastSeenSaveInterval: TimeInterval = 30

    // MARK: Last seen state

    /// 시작할 때: 저장한 연결의 마지막 상태가 있으면 읽기 전용으로 띄운다. 연결은 화면이 평소대로 시작한다.
    func restoreLastSeen() {
        guard !isDemo, offline.enabled, bootstrap == nil, connectedCredentials == nil, keepsLastSeen(for: endpoint),
              !accessCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let validated = try? ServerEndpoint(endpoint) else { return }
        let namespace = DraftStore.endpointNamespace(validated)
        guard let snapshot = offline.readLastSeen(namespace: namespace) else { return }
        showLastSeen(snapshot)
    }

    private func showLastSeen(_ snapshot: LastSeenSnapshot) {
        let namespace = snapshot.namespace
        lastSeen = LastSeenInfo(namespace: namespace, savedAt: snapshot.savedAt, serverID: snapshot.serverID)
        lastSeenAnnounced = false
        // 같은 서버의 초안·전송 기록·화면 위치를 그대로 쓴다. 쓰기는 연결 전이라 어차피 막힌다.
        writeNamespace = namespace
        drafts.selectNamespace(namespace)
        bootstrap = snapshot.bootstrap
        if let saved = snapshot.state, !saved.project.archived,
           snapshot.bootstrap.projects.contains(where: { $0.id == saved.project.id }) {
            selectedProjectID = saved.project.id
            state = saved
        }
        lastSeenNoticeTask?.cancel()
        lastSeenNoticeTask = Task { [weak self] in
            do { try await Task.sleep(for: Self.lastSeenNoticeDelay) } catch { return }
            guard let self, !Task.isCancelled, lastSeen != nil else { return }
            lastSeenAnnounced = true
        }
    }

    /// 이 연결에 마지막 상태를 쓰는가. Mac 앱이 이 Mac 의 서버에 붙을 때는 쓰지 않는다(서버가 꺼져 있으면 연결 화면의
    /// '이 Mac에서 시작'이 답이고, 마지막 상태가 그 단추를 가린다).
    func keepsLastSeen(for endpoint: String) -> Bool {
        lastSeenOnThisMac || !Self.serverIsThisMac(endpoint: endpoint, onMac: isMac)
    }

    /// 마지막 상태를 띄운 채 `endpoint` 로 붙으면 같은 서버인가(그 상태를 지우지 않고 이어 쓴다).
    func lastSeenMatches(_ endpoint: String) -> Bool {
        guard let lastSeen, let requested = try? ServerEndpoint(endpoint) else { return false }
        return DraftStore.endpointNamespace(requested) == lastSeen.namespace
    }

    /// 서버가 방금 확인해 준 상태가 화면에 들어왔다(readSnapshot 이 부른다).
    func didApplyLiveSnapshot() {
        if lastSeen != nil { endLastSeenNotice() }
        scheduleLastSeenSave()
    }

    /// 스냅샷 뒤 접수 확인까지 끝난 다음(readSnapshot 이 부른다). 보낼 글이 있을 때만 따로 돈다.
    func flushOutboxSoon() {
        guard !outboxFlushing, !queuedMessages.isEmpty || !offline.sent(namespace: writeNamespace).isEmpty else { return }
        Task { [weak self] in await self?.flushOutbox() }
    }

    private func endLastSeenNotice() {
        lastSeen = nil; lastSeenAnnounced = false
        lastSeenNoticeTask?.cancel(); lastSeenNoticeTask = nil
        lastSeenPeek = nil
    }

    /// 연결이 실패했을 때. 서버에 닿지 않은 것(망·Tailscale·서버 꺼짐)이면 마지막 상태를 그대로 두고 그 까닭을 줄에 보인다.
    /// 접속 코드 거절은 마지막 상태를 지우고, 그 밖의 실패(주소·응답 오류)는 예전처럼 연결 화면으로 돌아간다.
    func lastSeenConnectFailed(_ error: Error) {
        guard lastSeen != nil else { return }
        if ConnectionHealth.isUnreachable(error) {
            connectionIssue = error.localizedDescription
            errorMessage = nil
            lastSeenNoticeTask?.cancel(); lastSeenNoticeTask = nil
            lastSeenAnnounced = true
            return
        }
        if (error as? APIError)?.status == 401 { forgetLastSeen() } else { endLastSeenNotice() }
        leaveLastSeenDisplay()
    }

    /// 마지막 상태 줄의 '다시 연결'. 대표가 누른 시도는 '최신 상태를 받는 중'으로 보이고, 실패하면 다시 까닭을 보인다.
    /// 자동 재시도는 까닭을 그대로 두어 줄이 깜빡이지 않는다(4차 리뷰 ui-4).
    func reconnectFromLastSeen() async {
        connectionIssue = nil
        await connect()
    }

    /// 연결 없이 띄웠던 마지막 상태를 내린다(연결 화면으로). 파일은 건드리지 않는다.
    private func leaveLastSeenDisplay() {
        guard api == nil, connectedCredentials == nil else { return }
        bootstrap = nil; state = nil; selectedProjectID = nil
        writeNamespace = "unassigned"; drafts.selectNamespace("unassigned")
    }

    /// 다른 서버로 바꾸거나, 이 기기에서 나가거나, 접속 코드가 거절될 때: 표지와 파일을 함께 지운다.
    func forgetLastSeen() {
        lastSeenSaveTask?.cancel(); lastSeenSaveTask = nil
        offline.clearLastSeen()
        endLastSeenNotice()
    }

    /// 30초에 한 번까지 남긴다. 마지막으로 남긴 지 30초가 안 됐으면 그때까지 한 번 미룬다.
    func scheduleLastSeenSave() {
        guard offline.enabled, lastSeenSaveTask == nil else { return }
        let wait = lastSeenSavedAt.map { max(0, Self.lastSeenSaveInterval - Date().timeIntervalSince($0)) } ?? 0
        lastSeenSaveTask = Task { [weak self] in
            if wait > 0 { do { try await Task.sleep(for: .seconds(wait)) } catch { return } }
            guard let self, !Task.isCancelled else { return }
            lastSeenSaveTask = nil
            await saveLastSeenNow()
        }
    }

    /// 앱이 뒤로 갈 때와 시험이 부른다.
    func saveLastSeenNow() async {
        lastSeenSaveTask?.cancel(); lastSeenSaveTask = nil
        guard let snapshot = currentLastSeenSnapshot() else { return }
        lastSeenSavedAt = Date()
        await offline.saveLastSeen(snapshot)
    }

    /// 서버가 확인해 준 상태만 남긴다. 보관한 프로젝트를 보는 동안, 연결 전, 샘플은 남기지 않는다.
    func currentLastSeenSnapshot() -> LastSeenSnapshot? {
        guard !isDemo, offline.enabled, lastSeen == nil, !isArchive, writeNamespace != "unassigned",
              let credentials = connectedCredentials, keepsLastSeen(for: credentials.endpoint),
              connectionStatus == .connected || showsOffline,
              let bootstrap, let confirmed = lastSuccessfulSyncAt else { return nil }
        var saved = bootstrap
        // 진단·장애 같은 그때뿐인 값은 남기지 않는다(낡은 경고를 지금 것처럼 보이지 않게).
        saved.apiOutage = nil; saved.runtime = nil; saved.compat = nil
        let current = state.flatMap { $0.project.id == selectedProjectID && !$0.project.archived ? $0 : nil }
        return LastSeenSnapshot(namespace: writeNamespace, savedAt: confirmed, serverID: serverID, bootstrap: saved, state: current)
    }

    /// 서버가 데이터를 마지막으로 확인해 준 때(설정 → 연결). 마지막 상태를 보는 동안은 이번 실행에 확인한 때가 없어
    /// 그 상태를 남긴 때를 쓴다(4차 리뷰 ui-5).
    var lastDataCheckAt: Date? { lastSuccessfulSyncAt ?? lastSeen?.savedAt }

    /// '마지막으로 본 상태 · 12분 전'. 화면은 MinuteClock 으로 1분마다 다시 읽는다.
    var lastSeenAgeText: String? {
        guard let lastSeen else { return nil }
        return relativeTime(ISO8601DateFormatter().string(from: lastSeen.savedAt))
    }

    /// 마지막 상태를 보는 동안 다른 프로젝트를 고르면: 그 프로젝트의 상태는 기기에 없다.
    func explainLastSeenSelection() {
        guard lastSeen != nil else { return }
        projectNotice = String(localized: "마지막으로 본 상태에는 이 프로젝트만 있습니다. 연결되면 다른 프로젝트를 볼 수 있습니다.")
    }

    /// 마지막 상태를 보는 동안 알림을 눌렀으면 그 화면으로만 옮긴다. 알림은 꺼내지 않고 두어, 연결되면 평소대로
    /// 서버에 확인한 뒤 연다. 새로 누른 알림마다 한 번만 옮긴다.
    func peekNotificationInLastSeen(router: Router, inbox: NotificationInbox) {
        guard let lastSeen, api == nil, let link = inbox.pending.last, link != lastSeenPeek else { return }
        lastSeenPeek = link
        guard let serverID = lastSeen.serverID, link.serverID == serverID.lowercased() else { return }
        let projectID: String? = switch link.target {
        case .inbox(let project, _), .team(let project, _), .chat(let project, _, _, _), .projectHome(let project): project
        case .home, .unknown: nil
        }
        if let projectID, projectID != state?.project.id {
            notificationNotice = String(localized: "알림이 온 프로젝트는 연결되면 열 수 있습니다.")
            return
        }
        switch link.target {
        case .inbox(_, let decision):
            if decisions.contains(where: { $0.id == decision }) { router.openDecision(decision) }
            else {
                router.go(.inbox)
                notificationNotice = String(localized: "방금 알림이 온 결재는 아직 받지 못했습니다. 연결되면 보입니다.")
            }
        case .team(_, let member):
            if members.contains(where: { $0.id == member }) { router.openMember(member) } else { router.go(.team) }
        case .chat(_, let member, _, _):
            router.openChat(member.flatMap { id in members.contains(where: { $0.id == id }) ? id : nil })
        case .projectHome, .home: router.go(.home)
        case .unknown: break
        }
    }

    // MARK: Outbox

    /// 지금 고른 프로젝트에서 연결되면 보낼 글(오래된 것부터).
    var queuedMessages: [QueuedMessage] {
        guard let selectedProjectID, writeNamespace != "unassigned" else { return [] }
        return offline.items(namespace: writeNamespace, projectID: selectedProjectID)
    }
    /// 같은 서버의 다른 프로젝트에 둔 글 수(그 프로젝트를 열면 보낸다). 보낼 곳이 없는 글(아래)은 세지 않는다.
    var queuedElsewhereCount: Int {
        guard writeNamespace != "unassigned" else { return 0 }
        return offline.items(namespace: writeNamespace).count - queuedMessages.count - orphanQueuedMessages.count
    }
    /// 보관했거나 지운 프로젝트에 둔 글(이 서버 몫, 지금 고른 프로젝트 말고). 그 프로젝트가 프로젝트 목록에 없어 보낼 수 없다.
    /// 대기열 목록에 따로 보이고 지울 수 있다(4차 리뷰 data-5: 예전에는 보낼 수도, 볼 수도, 지울 수도 없었다).
    var orphanQueuedMessages: [QueuedMessage] {
        guard writeNamespace != "unassigned", let bootstrap else { return [] }
        let active = Set(bootstrap.projects.map(\.id))
        return offline.items(namespace: writeNamespace).filter { !active.contains($0.projectID) && $0.projectID != selectedProjectID }
    }
    var outboxPausedReason: String? {
        writeNamespace == "unassigned" ? nil : offline.pausedReason(namespace: writeNamespace)
    }

    /// 지금 바로 보낼 수 없고, 그 까닭이 '서버에 연결되지 않음'뿐인가. 이때 입력칸의 보내기는 '연결되면 보내기'가 된다.
    var waitsForConnection: Bool {
        !isDemo && !isArchive && projectArchived != true && writeNamespace != "unassigned"
            && selectedProjectID != nil && stateProjectID == selectedProjectID && !canWrite
            && (lastSeen != nil || showsOffline || isRestarting || connectionStatus != .connected)
    }

    /// 연결되면 보내기로 둘 수 없는 까닭(nil = 둘 수 있다). 입력칸의 지금 초안을 본다.
    func queueBlockReason(targetMemberID: String?) -> String? {
        guard waitsForConnection, let projectID = selectedProjectID else {
            return writeBlockedReason ?? String(localized: "지금은 연결되면 보내기를 쓸 수 없습니다.")
        }
        let key = DraftStore.key(project: projectID, target: targetMemberID)
        if let targetMemberID, !members.contains(where: { $0.id == targetMemberID }) {
            return String(localized: "명부에서 빠진 대상입니다. 보낼 대상을 바꿔 주세요.")
        }
        // 같은 입력칸에서 앞서 보낸 글의 결과를 아직 모르면 막는다(보내기의 판정과 같다. 4차 리뷰 data-1).
        // 그 글이 접수된 것으로 밝혀진 뒤 같은 글이 대기열에서 한 번 더 나가지 않게 한다.
        let pending = ComposerBar.pendingAttempt(in: self, key: key)
        let failures = submissions?.failureNotices(namespace: drafts.namespace, key: key, drafts: drafts) ?? []
        if pending?.status == .checking || pending?.status == .accepted || failures.contains(where: { $0.status == .checking }) {
            return String(localized: "앞서 보낸 글의 접수를 확인한 뒤 넣어 주세요.")
        }
        if let pending, (pending.restoredDraft ?? pending.draft).revision != drafts.revision(for: key) {
            return String(localized: "이전 글의 접수 결과를 확인하고 편집한 글 사용을 눌러 주세요.")
        }
        if !drafts.files(for: key).isEmpty || !composerUploads.pending(for: key, drafts: drafts).isEmpty
            || !drafts.uploadFailures(for: key).isEmpty {
            return String(localized: "첨부가 있는 글은 연결된 뒤에 보내 주세요.")
        }
        if let error = offline.persistenceError { return OutboxError.unavailable(error).localizedDescription }
        if offline.items(namespace: writeNamespace).count >= OfflineStateStore.itemLimit { return OutboxError.full.localizedDescription }
        let text = drafts.text(for: key)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return OutboxError.empty.localizedDescription }
        if text.count > OfflineStateStore.textLimit { return OutboxError.tooLong.localizedDescription }
        return nil
    }

    /// 입력칸의 글을 연결되면 보낼 글로 둔다. 기기에 남긴 뒤에야 입력칸을 비운다(그 사이 더 쓴 글은 남긴다).
    @discardableResult func queueMessage(targetMemberID: String?) -> Bool {
        let key = DraftStore.key(project: selectedProjectID, target: targetMemberID)
        drafts.commitEditors(for: key)
        if let reason = queueBlockReason(targetMemberID: targetMemberID) {
            explainMessageSendBlock(reason, targetMemberID: targetMemberID)
            return false
        }
        guard let projectID = selectedProjectID else { return false }
        let snapshot = drafts.snapshot(for: key)
        let name = targetMemberID.flatMap { id in members.first { $0.id == id }?.name }
        do {
            try offline.enqueue(namespace: writeNamespace, projectID: projectID, targetMemberID: targetMemberID,
                                targetName: name, text: snapshot.text, owner: bootstrap.map { QueueOwner($0) })
        } catch {
            explainMessageSendBlock(error.localizedDescription, targetMemberID: targetMemberID, whileBlocked: false)
            return false
        }
        drafts.consumeSent(snapshot)
        clearBlockedSendNotice(targetMemberID: targetMemberID)
        return true
    }

    /// 고친 글은 새 글로 바뀐다(같은 자리). 돌려주는 값은 실패 까닭(nil = 고침).
    @discardableResult func editQueuedMessage(id: String, text: String) -> String? {
        do {
            try offline.replaceText(id: id, with: text)
            dismissPreparedQueueAttempts(generation: UUID(uuidString: id))
            return nil
        } catch { return error.localizedDescription }
    }

    @discardableResult func deleteQueuedMessage(id: String) -> String? {
        do {
            try offline.remove(id: id)
            dismissPreparedQueueAttempts(generation: UUID(uuidString: id))
            return nil
        } catch { return error.localizedDescription }
    }

    /// 연결되면 보낼 글은 주소별로 둔다. 같은 서버를 다른 주소(*.ts.net 이름 ↔ HTTPS ↔ 100.x)로 다시 붙으면 예전에는 '다른 서버'로
    /// 보고 그 글을 말없이 지웠다(4차 확인 새 문제 2. 401 뒤 QR 다시 연결에서 HTTPS 주소가 앞에 오면 흔하다). 이제 그 주소 몫을
    /// 이 주소 몫으로 옮겨 순서대로 보낸다. 연결이 성공한 뒤 `removeAll(except:)` 앞에서 부른다.
    func carryOutboxFromOtherAddresses(server: Bootstrap) {
        let here = writeNamespace
        guard here != "unassigned" else { return }
        for namespace in offline.namespaces.sorted() where namespace != here
            && Self.sameServer(namespace, owner: offline.owner(namespace: namespace), as: here, server: server) {
            try? offline.moveQueue(from: namespace, to: here, owner: QueueOwner(server),
                                   waitingReason: String(localized: "앞서 보낸 글의 접수를 확인하기 전에 서버 주소가 바뀌었습니다. 대화에서 그 글이 들어갔는지 확인한 뒤 이어서 보내 주세요."))
        }
    }

    /// `old` 주소 몫의 글(그 글을 쓸 때 보던 서버 `owner`)이 지금 `current` 주소로 붙은 `server` 의 것인가.
    /// - 같은 데이터 폴더(Bootstrap.home)를 쓰는 서버여야 한다. 같은 Mac 의 시험 서버처럼 폴더가 다른 서버는 다른 서버다.
    /// - 그리고 같은 기기여야 한다: 주소의 호스트가 같거나(포트·http/https 만 다름: *.ts.net 이름 ↔ HTTPS),
    ///   한쪽 서버가 다른 쪽 주소를 자기 주소로 알려 주었다(Bootstrap.urls 는 100.x 처럼 IP 만 싣는다). 알려 준 주소는
    ///   Tailscale 주소만 센다: 127.0.0.1 은 어느 Mac 에서나 그 Mac 자신이라 기기를 가리지 못한다(PairingRequest.knownHosts 와 같다).
    /// - 표지가 없는 글(표지를 남기기 전 판)은 예전처럼 다른 서버로 본다.
    static func sameServer(_ old: String, owner: QueueOwner?, as current: String, server: Bootstrap) -> Bool {
        func endpoint(_ address: String) -> ServerEndpoint? { try? ServerEndpoint(address) }
        func origin(_ address: String) -> String? { endpoint(address).map(DraftStore.endpointNamespace) }
        func onTailnet(_ address: String) -> Bool { endpoint(address)?.url.host.map(Tailnet.isTailnetHost) ?? false }
        guard let oldOrigin = origin(old), let currentOrigin = origin(current) else { return false }
        if oldOrigin == currentOrigin { return true }
        guard let owner, !owner.home.isEmpty, owner.home == server.home else { return false }
        if let a = endpoint(old)?.url.host?.lowercased(), a == endpoint(current)?.url.host?.lowercased() { return true }
        return (onTailnet(old) && server.urls.contains { origin($0) == oldOrigin })
            || (onTailnet(current) && owner.addresses.contains { origin($0) == currentOrigin })
    }

    /// '이어서 보내기': 멈춘 까닭을 대표가 확인했다.
    func resumeOutbox() {
        guard writeNamespace != "unassigned" else { return }
        do { try offline.resume(namespace: writeNamespace) } catch { errorMessage = error.localizedDescription; return }
        Task { [weak self] in await self?.flushOutbox() }
    }

    /// 연결되면 고른 프로젝트의 글을 오래된 것부터 하나씩 보낸다. 한 번에 한 줄만 돈다.
    func flushOutbox() async {
        guard !outboxFlushing, canWrite, submissions != nil, let projectID = selectedProjectID else { return }
        let namespace = writeNamespace
        outboxFlushing = true
        defer { outboxFlushing = false }
        settleSentQueue(namespace: namespace)
        // 앞서 보낸 글의 결과를 아직 모르면 기다린다(순서를 지킨다). 접수 확인이 결과를 정하면 다음 스냅샷에서 이어 간다.
        guard offline.pausedReason(namespace: namespace) == nil, offline.sent(namespace: namespace).isEmpty else { return }
        dismissPreparedQueueAttempts(generation: nil)
        let epoch = generation, projectEpoch = projectGeneration
        var accepted = false
        while let item = offline.items(namespace: namespace, projectID: projectID).first {
            guard epoch == generation, projectEpoch == projectGeneration, canWrite,
                  offline.pausedReason(namespace: namespace) == nil else { break }
            guard await sendQueuedMessage(item) == .accepted else { break }
            accepted = true
        }
        if accepted, epoch == generation { await refresh() }
    }

    enum QueuedSendResult: Equatable { case accepted, refused, unknown, blocked }

    /// 대기열의 글 하나를 보낸다. 보내기 직전(같은 순간)에 대기열에서 빼고 전송 기록에 맡긴다.
    func sendQueuedMessage(_ item: QueuedMessage) async -> QueuedSendResult {
        guard canWrite, let submissions, item.namespace == writeNamespace, item.projectID == selectedProjectID else { return .blocked }
        let who = item.targetName ?? leadRankName
        if let target = item.targetMemberID, !members.contains(where: { $0.id == target }) {
            try? offline.pause(namespace: item.namespace,
                               reason: String(localized: "받는 사람(\(who))이 명부에서 빠져 보내지 않았습니다. 그 글을 지운 뒤 이어서 보내 주세요."))
            return .blocked
        }
        guard !isSending(projectID: item.projectID, targetMemberID: item.targetMemberID) else { return .blocked }
        let epoch = generation
        let actionKey = sendActionKey(projectID: item.projectID, targetMemberID: item.targetMemberID)
        let owner = holdAction(actionKey)
        defer { if epoch == generation { releaseAction(actionKey, owner: owner) } }
        // 앱이 꺼지기 직전에 이미 보내기 시작한 글이다(대기열에서 빼기 전에 멈췄다). 다시 보내지 않고 그 기록이 맡는다.
        if let earlier = submissions.messages(namespace: item.namespace).first(where: {
            $0.draft.generation == item.draftGeneration && $0.handoffID == nil && $0.status != .prepared
                && $0.failureDisposition != .dismissed
        }) {
            try? offline.markSent(id: item.id, attemptID: earlier.id)
            return .unknown
        }
        let draft = DraftSnapshot(namespace: item.namespace, key: item.draftKey, generation: item.draftGeneration, revision: 0,
                                  textRevision: 0, text: item.text, attachments: [], attachmentRevisions: [:])
        let attempt: MessageSubmission
        // 같은 사람에게 보낸 앞선 글의 결과를 확인하는 중이면 기다린다.
        do { attempt = try submissions.prepareMessage(projectID: item.projectID, targetMemberID: item.targetMemberID, draft: draft) }
        catch { return .blocked }
        guard attempt.status == .prepared else {
            // 앱이 꺼지기 직전에 이미 보내기 시작한 글이다. 다시 보내지 않고 그 기록의 결과를 기다린다.
            try? offline.markSent(id: item.id, attemptID: attempt.id)
            return .unknown
        }
        let outcome: (value: Message?, error: Error?) = await perform(actionKey, refreshAfter: false, deferRefusalToReceipt: true,
                                                                       ownsPendingAction: true) { api in
            let request = try submissions.beginMessage(id: attempt.id)
            do { try self.offline.markSent(id: item.id, attemptID: attempt.id) }
            catch {
                // 대기열에서 빼지 못했으면 보내지 않는다. 시작한 기록은 접어 두고 글은 대기열에 남긴다.
                try? submissions.refuseMessage(id: attempt.id)
                try? submissions.dismissMessageFailure(id: attempt.id)
                throw error
            }
            return try await api.sendMessage(projectID: item.projectID, request: request,
                                             contractVersion: self.strictWriteContract ? 2 : nil)
        }
        let status = submissions.messageAttempt(id: attempt.id)?.status
        // perform 이 연결을 확인하다 멈췄다: 아무것도 보내지 않았다. 다음에 같은 기록으로 이어 간다.
        if status == .prepared || (status == .refused && offline.items(namespace: item.namespace).contains(where: { $0.id == item.id })) {
            return .blocked
        }
        if Self.definiteRefusal(outcome.error) || status == .notAccepted {
            try? submissions.refuseMessage(id: attempt.id, reason: outcome.error?.localizedDescription ?? String(localized: "서버가 접수하지 않았습니다"))
            // 입력칸 위의 '보내지 못한 글'(다시 보내기·입력칸에 넣기·버리기)로 남긴다.
            try? submissions.restoreMessage(id: attempt.id, drafts: drafts)
            try? offline.settle(attemptID: attempt.id)
            try? offline.pause(namespace: item.namespace,
                               reason: String(localized: "\(who)에게 보낼 글이 접수되지 않아 나머지는 멈춰 두었습니다. 입력칸의 안내를 확인한 뒤 이어서 보내 주세요."))
            return .refused
        }
        guard epoch == generation else { return .unknown }
        if let message = outcome.value {
            try? submissions.acceptMessage(id: attempt.id, message: message)
            receiveHistoryMessage(message)
            try? submissions.consumeAccepted(id: attempt.id, drafts: drafts)
            try? offline.settle(attemptID: attempt.id)
            return .accepted
        }
        // 결과를 모른다. 접수 확인(recoverWrites)이 같은 ID 로 조회한다. 다시 보내지 않는다.
        return .unknown
    }

    /// 대기열에서 나간 글의 결과를 본다. 접수됐으면 놓고, 접수되지 않았으면 나머지를 멈춘다.
    private func settleSentQueue(namespace: String) {
        for sent in offline.sent(namespace: namespace) {
            switch submissions?.messageAttempt(id: sent.attemptID)?.status {
            case .checking?: continue
            case .refused?, .notAccepted?:
                try? offline.settle(attemptID: sent.attemptID)
                try? offline.pause(namespace: namespace,
                                   reason: String(localized: "앞서 보낸 글이 접수되지 않아 나머지는 멈춰 두었습니다. 입력칸의 안내를 확인한 뒤 이어서 보내 주세요."))
            case .accepted?, .prepared?, nil:
                try? offline.settle(attemptID: sent.attemptID)
            }
        }
    }

    /// 보내기 직전에 앱이 꺼진 뒤 대표가 그 글을 고치거나 지웠으면, 서버로 가지 않은 옛 기록을 접는다.
    /// `generation` 이 있으면 그 글의 기록만, 없으면 대기열에 없는 글의 기록 전부.
    private func dismissPreparedQueueAttempts(generation: UUID?) {
        guard let submissions, writeNamespace != "unassigned" else { return }
        let queued = Set(offline.items(namespace: writeNamespace).map(\.draftGeneration))
        for attempt in submissions.messages(namespace: writeNamespace) where attempt.status == .prepared && attempt.handoffID == nil
            && (generation.map { attempt.draft.generation == $0 } ?? !queued.contains(attempt.draft.generation)) {
            try? submissions.refuseMessage(id: attempt.id)
            try? submissions.dismissMessageFailure(id: attempt.id)
        }
    }
}

#if DEBUG
extension AppStore {
    /// 화면 견본(DEBUG, `--last-seen-preview`): 샘플 자료를 '12분 전에 본 마지막 상태'로 띄우고, Tailscale 이 꺼진 기기처럼
    /// 연결이 실패하게 한다. 요청은 기기를 떠나지 않는다(Tailscale 확인이 보내기 전에 막는다). 연결되면 보낼 글 두 개를
    /// 메모리에만 둔다. 파일·키체인·알림 등록은 쓰지 않는다.
    static func lastSeenPreview(now: Date = Date()) -> AppStore {
        let store = AppStore(persistCredentials: false, restoreCredentials: false, offline: OfflineStateStore(persist: false))
        store.tailnetConnected = { false }
        store.endpoint = "http://100.64.0.1:7878"; store.accessCode = "preview"
        guard let endpoint = try? ServerEndpoint(store.endpoint) else { return store }
        let (bootstrap, state) = DemoFixtures.workspace(now: now)
        let namespace = DraftStore.endpointNamespace(endpoint)
        store.showLastSeen(LastSeenSnapshot(namespace: namespace, savedAt: now.addingTimeInterval(-12 * 60), serverID: nil,
                                            bootstrap: bootstrap, state: state))
        let worker = state.members.first { $0.kind == "worker" }
        _ = try? store.offline.enqueue(namespace: namespace, projectID: state.project.id, targetMemberID: nil, targetName: nil,
                                       text: "결제 실패 화면 문구를 오늘 안에 정리해 주세요.", now: now.addingTimeInterval(-300))
        if let worker {
            _ = try? store.offline.enqueue(namespace: namespace, projectID: state.project.id, targetMemberID: worker.id,
                                           targetName: worker.name, text: "테스트 카드로 한 번 더 확인해 주세요.",
                                           now: now.addingTimeInterval(-60))
        }
        return store
    }
}
#endif
