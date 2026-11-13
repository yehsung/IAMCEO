import Foundation

// AppStore 의 알림 이동: 창(장면)마다의 Router 등록, 이 서버의 알림 연결(serverId·푸시 호스트), 알림을 눌렀을 때
// 그 서버·프로젝트·항목이 아직 맞는지 확인한 뒤 화면을 옮기는 일. 한 알림은 먼저 꺼낸 창 하나만 연다.

@MainActor final class WeakRouter {
    weak var value: Router?
    init(_ value: Router) { self.value = value }
}

extension AppStore {
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

    func clearHostNavigation() {
        serverID = nil; pushConnectionError = nil; pendingNotification = nil; notificationNotice = nil
        leaveNotificationAnchor()
        for router in routers { router.value?.resetForConnectionChange() }
    }

    func leaveNotificationAnchor() {
        notificationMessages = []; notificationMessageID = nil; notificationScope = nil
    }

    func beginPushLogout() {
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
                    // Another server now answers at this address: what was chosen and offered belonged to the old one.
                    permissionChosenNamespace = nil; permissionChoiceOffered = nil
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
            pushRetryAttempt = 0
            pushRetryTask?.cancel(); pushRetryTask = nil
            await pushNotifications?.foreground()
        } catch {
            guard epoch == generation, phase == foregroundGeneration else { return }
            // Unsupported or unhealthy push is not a failure of the application connection.
            if (error as? APIError)?.status == 401 { handle(error) }
            else if let error = error as? APIError, [404, 501].contains(error.status) { pushConnectionError = .unsupported }
            else if error is SubmissionError || error is DecodingError { pushConnectionError = .invalidResponse }
            else {
                pushConnectionError = .requestFailed((error as? APIError)?.status ?? 0)
                schedulePushRetry(error)
            }
        }
    }

    /// 이 조회가 일시적으로 실패하면 serverID가 비어 알림 이동과 푸시 등록이 멈춘다. 몇 번만 다시 묻는다.
    private func schedulePushRetry(_ error: Error) {
        guard foreground, api != nil, pushRetryTask == nil, pushRetryAttempt < 3,
              error is URLError || ((error as? APIError)?.status ?? 0) >= 500 else { return }
        let delay: Duration = [.seconds(5), .seconds(15), .seconds(60)][pushRetryAttempt]
        pushRetryAttempt += 1
        let epoch = generation, phase = foregroundGeneration
        pushRetryTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            pushRetryTask = nil
            await refreshPushConnection()
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
                    throw APIError(status: 404, message: "팀원을 찾을 수 없습니다.")
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
}
