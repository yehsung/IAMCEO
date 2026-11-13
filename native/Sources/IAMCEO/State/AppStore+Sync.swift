import Foundation

// AppStore 의 동기화 조정자: 읽기 요청을 한 줄로 모아(dirty·대기자) /api/sync(또는 옛 서버의 bootstrap·state)를 읽고,
// 실시간 소켓의 사건으로 무엇을 다시 읽을지 정한다. 활동·진단·보관함 읽기도 이 대기열을 탄다.
// 낡은 응답은 세대 토큰(generation, projectGeneration, foregroundGeneration, coordinatorGeneration, refreshGeneration,
// socketGeneration)으로 버린다. 순서가 미묘하니 고칠 때는 Mac·iPhone 시험을 모두 돌린다.

struct RefreshScope: OptionSet {
    let rawValue: Int
    static let snapshot = Self(rawValue: 1)
    static let history = Self(rawValue: 2)
    static let delivery = Self(rawValue: 4)
    static let activity = Self(rawValue: 8)
    static let diagnostics = Self(rawValue: 16)
    static let archive = Self(rawValue: 32)
    static let all: Self = [.snapshot, .history, .delivery, .activity]
}

struct AppliedSyncIdentity: Equatable {
    let selection: UUID
    let cursor: SyncCursor
    let revisions: SyncRevisions?
    let projectStatus: SyncProjectStatus
}

struct RefreshSnapshot: Sendable { let bootstrap: Bootstrap; let state: ProjectState?; let sync: SyncSnapshot? }

extension AppStore {
    /// Manual refreshes and all post-write invalidations share the event single flight.
    func refresh() async { await refresh(onSnapshot: nil) }
    func refresh(onSnapshot: (@MainActor () -> Void)?) async {
        guard !isDemo, api != nil, connectionStatus == .connected || connectionLost else { return }
        if realtimeStatus == .blocked, foreground {
            restFailures = 0; startSocket(); startFallback()
        }
        await enqueueRefresh(.all, immediate: true, allowPaused: true, onSnapshot: onSnapshot)
    }

    func refreshDiagnostics() async { await enqueueRefresh(.diagnostics, immediate: true) }

    func invalidateCoordinator() {
        coordinatorGeneration = UUID(); refreshGeneration = UUID()
        coordinatorTask?.cancel(); coordinatorTask = nil
        refreshTask?.cancel(); refreshTask = nil
        initialTask?.cancel(); initialTask = nil
        dirty = []; activePassRevision = nil; urgentRefresh = false
        pacingTask?.cancel(); pacingTask = nil
        finishRefreshWaiters()
    }

    private func finishRefreshWaiters(through revision: Int? = nil) {
        for (id, waiter) in refreshWaiters where revision.map({ waiter.revision <= $0 }) ?? true {
            snapshotHooks.removeValue(forKey: id)
            refreshWaiters.removeValue(forKey: id)?.continuation.resume()
        }
    }

    private func releaseSnapshotWaiters(through revision: Int) {
        for (id, hook) in snapshotHooks where hook.revision <= revision {
            snapshotHooks.removeValue(forKey: id)
            hook.action()
        }
    }

    func enqueueRefresh(_ scope: RefreshScope, immediate: Bool = false, allowPaused: Bool = false,
                                onSnapshot: (@MainActor () -> Void)? = nil) async {
        guard !isDemo, api != nil, foreground || allowPaused else { return }
        dirty.formUnion(scope); dirtyRevision &+= 1
        if scope.contains(.history) { historyInvalidationRevision &+= 1 }
        if immediate { urgentRefresh = true; pacingTask?.cancel() }
        // 돌고 있는 읽기의 복구 조회 안에서 부른 새로고침은 표시만 남긴다. 이 읽기가 끝나면 이어서 한 번 더 돈다.
        // 여기서 기다리면 읽기가 자기 자신을 기다려 다시는 끝나지 않는다.
        if coordinatorTask != nil, let pass = Self.recoveryPass, pass == activeRecoveryPass { return }
        let requestedRevision = dirtyRevision
        let waiterID = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(); return }
                // Register before starting the task, including when every read completes immediately.
                refreshWaiters[waiterID] = (requestedRevision, continuation)
                if let onSnapshot { snapshotHooks[waiterID] = (requestedRevision, onSnapshot) }
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
                                if dirty.contains(.snapshot), !urgentRefresh {
                                    // 이벤트만으로 도는 읽기는 서버가 느린 만큼 간격을 벌린다. 급한 요청이 오면 바로 깬다.
                                    let wait = eventSnapshotAt - (await syncClock.now())
                                    if wait > .zero, !urgentRefresh, token == coordinatorGeneration {
                                        let pause = Task { [syncClock] in _ = try? await syncClock.sleep(for: wait) }
                                        pacingTask = pause
                                        await pause.value
                                        if pacingTask == pause { pacingTask = nil }
                                    }
                                    guard !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration else { return }
                                }
                                let scopes = dirty, passRevision = dirtyRevision, passStart = resyncRevision
                                dirty = []; urgentRefresh = false
                                let now = await syncClock.now()
                                if scopes.contains(.snapshot) {
                                    let delay = nextSnapshotAt - now
                                    if delay > .zero { try await syncClock.sleep(for: delay) }
                                    guard !Task.isCancelled, token == coordinatorGeneration else { return }
                                    let startedAt = await syncClock.now()
                                    nextSnapshotAt = startedAt + (lowPowerMode ? .seconds(1) : .milliseconds(500))
                                    activePassRevision = passRevision
                                    await readSnapshot(startedAt: startedAt)
                                    if token == coordinatorGeneration {
                                        activePassRevision = nil
                                        releaseSnapshotWaiters(through: passRevision)
                                    }
                                }
                                let passSync = resyncRevision
                                guard !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration else { return }
                                if scopes.contains(.history), historyVisible { await refreshHistory() }
                                if scopes.contains(.delivery), foreground {
                                    for memberID in Set(deliveryWatchers.values).union(deliveryFlights.keys) {
                                        if memberID.isEmpty { await loadUnassignedDeliveries() }
                                        else { await loadDeliveryNotices(memberID: memberID) }
                                        guard !Task.isCancelled, token == coordinatorGeneration else { return }
                                    }
                                }
                                if scopes.contains(.activity) { await readActivities() }
                                if scopes.contains(.diagnostics) { await readDiagnostics() }
                                if scopes.contains(.archive) { await loadArchivedProjects() }
                                guard !Task.isCancelled, token == coordinatorGeneration, epoch == generation, phase == foregroundGeneration else { return }
                                // 전체를 다 읽은 지점을 기억해 둔다. 같은 지점의 hello가 오면 다시 읽지 않는다.
                                if scopes.isSuperset(of: .all), passSync != passStart { fullPassCursor = lastSnapshotCursor }
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
                self?.snapshotHooks.removeValue(forKey: waiterID)
                self?.refreshWaiters.removeValue(forKey: waiterID)?.continuation.resume()
            }
        }
    }

    func discoverCapabilities(using client: APIClient? = nil) async {
        // 일시적으로 실패한 조회는 다음 기회(복귀, 다시 연결, 실시간 hello)에 다시 한다.
        guard !capabilitiesLoaded || capabilityProbeFailed, let api = client ?? api else { return }
        let epoch = generation, phase = foregroundGeneration
        do {
            let capabilities = try await api.capabilities()
            guard epoch == generation, phase == foregroundGeneration else { return }
            capabilitiesLoaded = true; capabilityProbeFailed = false
            strictWriteContract = capabilities.contractVersion == 2 && capabilities.capabilities?.operations == true
            realtimeSupported = capabilities.contractVersion == 2 && capabilities.capabilities?.realtime == true
            syncSupported = capabilities.contractVersion == 2 && (capabilities.capabilities?.realtime == true || strictWriteContract)
        } catch {
            guard epoch == generation, phase == foregroundGeneration else { return }
            if (error as? APIError)?.status == 401 { handle(error); return }
            guard !Task.isCancelled else { return }
            // Discovery is optional (spec 3.3). A completed failed probe opens the
            // unadvertised v1 path; it never clears a previously confirmed v2 contract.
            capabilitiesLoaded = true; capabilityProbeFailed = true
        }
    }

    private func readSnapshot(startedAt: Duration) async {
        guard let api else { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration
        let socketEpoch = socketGeneration, requestID = UUID()
        refreshGeneration = requestID
        let projectID = selectedProjectID, archived = isArchive
        let supportsSync = syncSupported, optionalWriteContext = !realtimeSupported
        let explicitSelection = isLoading
        let seeded = seededBootstrap
        seededBootstrap = nil
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
            var next: Bootstrap
            if let seeded { next = seeded } else { next = try await api.request("/api/bootstrap") }
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
                  requestID == refreshGeneration else { return }
            paceEvents(readStarted: startedAt, finished: completedAt)
            if let next = result.state {
                guard next.project.id == projectID, next.project.archived == archived else { throw SubmissionError.mismatchedResult }
            }
            var applyDomain = true
            if let snapshot = result.sync {
                guard snapshot.requestedProjectId == (archived ? nil : projectID), snapshot.projectStatus != .unknown else { throw SubmissionError.mismatchedResult }
                if socketHello, let receivedCursor, snapshot.cursor.epoch != receivedCursor.epoch {
                    // 읽는 사이 소켓이 다시 붙어 새 서버를 알렸다. 옛 결과는 실패로 세지 않고 바로 다시 읽는다.
                    if socketEpoch != socketGeneration { dirty.formUnion(.snapshot); return }
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
            lastSnapshotCursor = result.sync?.cursor
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
            // 스냅샷이 화면에 반영됐다. 쓰기 뒤 잠금은 여기서 풀어 아래 복구 조회가 붙잡지 않게 한다.
            if let activePassRevision { releaseSnapshotWaiters(through: activePassRevision) }
            let recovery = UUID()
            activeRecoveryPass = recovery
            await Self.$recoveryPass.withValue(recovery) {
                await reconcileProjectChanges()
                await recoverWrites()
            }
            if activeRecoveryPass == recovery { activeRecoveryPass = nil }
        } catch {
            // 읽는 사이 소켓이 다시 붙었어도 이 요청의 실패는 버리지 않는다. 버리면 끊김 판정이 영영 시작되지 않는다.
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                  requestID == refreshGeneration else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if (error as? APIError)?.status == 401 { handle(error); return }
            if let apiError = error as? APIError, apiError.status == 503, apiError.code == "STARTING", !health.restartWindowUsed || isRestarting {
                await beginRestart()
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                      requestID == refreshGeneration else { return }
                scheduleSyncRetry(after: .milliseconds(500))
                return
            }
            if isRestarting {
                scheduleSyncRetry(after: .milliseconds(500))
                return
            }
            restFailures += 1
            health.answeredFailure = !ConnectionHealth.isUnreachable(error)
            let unreadable = (error as? APIError)?.code == APIClient.unreadableCode
            unreadableFailures = unreadable ? unreadableFailures + 1 : 0
            Self.connectionLogger.error("sync_failed status=\((error as? APIError)?.status ?? -1, privacy: .public) code=\((error as? APIError)?.code ?? "-", privacy: .public) unreadable=\(unreadable, privacy: .public) failures=\(self.restFailures, privacy: .public)")
            if ConnectionHealth.isUnreachable(error) {
                await markUnreachable(error)
            } else {
                // A response or a local consistency failure is a sync problem, never loss evidence.
                health.transportFailures = 0; health.firstTransportFailure = nil
                offlineTask?.cancel(); offlineTask = nil
                isRevalidating = true; isCheckingConnection = true
                connectionIssue = "동기화 다시 시도 중"
                clearReadError()
            }
            let now = await syncClock.now()
            guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration,
                  requestID == refreshGeneration else { return }
            paceEvents(readStarted: startedAt, finished: now)
            let delay = health.nextSyncRetryDelay(after: error, at: now, restFailures: restFailures, host: self.api?.endpoint.url.host)
            scheduleSyncRetry(after: delay)
        }
    }

    /// 읽기에 걸린 시간의 두 배(최대 5초)만큼 다음 이벤트 읽기를 미룬다. 빠른 서버에서는 기본 간격(0.5초) 그대로다.
    private func paceEvents(readStarted: Duration, finished: Duration) {
        let cost = max(.zero, finished - readStarted)
        eventSnapshotAt = finished + min(.seconds(5), cost * 2)
    }

    func startSocket() {
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

    func stopSocket() {
        socketGeneration = UUID(); socketHello = false; lastSocketFrame = nil
        socketTask?.cancel(); socketTask = nil
        guard let realtime else { return }
        let previous = socketTransition
        socketTransition = Task { await previous?.value; await realtime.disconnect() }
    }

    func socketFailed() {
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

    func startFallback() {
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
            if event.cursor != nil, capabilityProbeFailed {
                // v2 서버가 확인됐다. 일시적으로 실패한 기능 조회를 다시 해 구형 쓰기 방식에 묶이지 않게 한다.
                Task { [weak self] in await self?.discoverCapabilities() }
            }
            // Join an in-flight snapshot. Its result is checked against this hello's cursor below.
            if refreshTask == nil {
                if let cursor = event.cursor, let read = fullPassCursor, read == appliedSnapshotCursor,
                   read.epoch == cursor.epoch, read.seq >= cursor.seq,
                   validatedProjectGeneration == projectGeneration, validatedWriteGeneration == projectGeneration,
                   !dirty.contains(.snapshot), !isRevalidating, !showsOffline, !isRestarting, restFailures == 0 {
                    // 방금 전체를 읽은 지점과 이 hello의 지점이 같다. 그사이 바뀐 것이 없으니 다시 읽지 않는다.
                    socketFailures = 0
                    if foreground { realtimeStatus = .live; fallbackTask?.cancel(); fallbackTask = nil }
                    return
                }
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
        if event.payloadUnreadable {
            // 본문을 읽지 못한 변경이다. 무엇이 바뀌었는지 모르니 열려 있는 것을 모두 다시 읽는다.
            if let cursor = event.cursor { highestRelevantSeq = max(highestRelevantSeq, cursor.seq) }
            Task { [weak self] in await self?.enqueueRefresh(.all) }
            return
        }
        if event.type == "activity" {
            if event.projectId == selectedProjectID, let item = event.activity, openActivityMembers.contains(item.memberId) {
                let memberID = item.memberId
                activityRevisions[memberID, default: 0] &+= 1
                if event.cursor != nil, var rows = activities[memberID] {
                    // 이벤트에 실린 항목을 그대로 끼운다. 순번이 건너뛰면 위에서 전체를 다시 읽는다.
                    if !rows.contains(where: { $0.id == item.id }) {
                        rows.append(item); rows.sort { $0.id > $1.id }
                        if rows.count > 100 { rows.removeLast(rows.count - 100) }
                        activities[memberID] = rows
                    }
                } else {
                    // 아직 목록을 읽지 못했거나 순번이 없는 구형 서버다. 목록을 다시 읽는다.
                    Task { [weak self] in await self?.enqueueRefresh(.activity) }
                }
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
        // projects 이벤트는 따로 이벤트가 없는 변화(API 장애 표시, 전달 안내 집계)를 알리는 신호로도 온다. 실린 목록만 쓰고 넘기지 않는다.
        if let cursor = event.cursor { highestRelevantSeq = max(highestRelevantSeq, cursor.seq) }
        var scope: RefreshScope = !known && !global ? .all : .snapshot
        if event.type == "message" {
            var placed = false
            if let message = event.message {
                receiveHistoryMessage(message)
                // 순번이 이어진 글은 이미 대화에 놓였다. 놓을 자리를 찾지 못한 글만 최신 쪽을 다시 읽는다.
                placed = event.cursor != nil && history?.settled(message) != false
            }
            scope.insert(.delivery)
            if !placed { scope.insert(.history) }
        } else if event.type == "member" {
            scope.insert(.delivery)
            // 대화 범위는 팀장이 누구인지에만 달려 있다. 상태만 바뀐 직원 때문에 대화를 다시 읽지 않는다.
            let current = members.first { $0.id == event.member?.id }
            // 다만 전달을 기다리는 내 글의 대기 사유(승인 대기, 사용 한도, 동시 실행 한도 등)는 서버가 읽을 때 직원 상태로
            // 계산하고, 바뀌어도 글 이벤트가 따로 오지 않는다. 그런 글이 보이는 동안에는 다시 읽어 문구를 맞춘다.
            if event.cursor == nil || current == nil || current?.kind != event.member?.kind || historyAwaitsDelivery { scope.insert(.history) }
        } else if event.type == "member_removed" {
            scope.formUnion([.delivery, .history])
        } else if !known { scope.insert(.delivery) }
        Task { [weak self] in await self?.enqueueRefresh(scope) }
    }

    /// 지금 보는 대화에 아직 전달을 기다리는 내 글이 있는가.
    private var historyAwaitsDelivery: Bool {
        guard historyVisible, let history else { return false }
        return history.items.contains { $0.mine && ["queued", "held", "delivering"].contains($0.delivery ?? "") }
    }

    /// 활동 목록이 화면에 떠 있는 동안만 등록한다. 목록은 한 번 읽고, 그 뒤는 실시간 이벤트가 채운다.
    /// 실시간이 끊긴 동안에는 주기적인 전체 읽기가 함께 다시 읽는다.
    /// 등록했으면 true. 등록한 쪽만 deactivateActivity로 푼다.
    @discardableResult func activateActivity(memberID: String) async -> Bool {
        guard members.contains(where: { $0.id == memberID }) else { return false }
        activityWatchCounts[memberID, default: 0] += 1
        openActivityMembers.insert(memberID); activityTokens[memberID] = UUID()
        await enqueueRefresh(.activity, immediate: true)
        return true
    }
    /// `epoch`는 등록할 때의 `activityEpoch`. 그 뒤 등록이 통째로 비워졌으면(다시 연결) 늦게 온 해제가
    /// 새로 한 등록을 지우지 않게 아무것도 하지 않는다.
    func deactivateActivity(memberID: String, epoch: Int? = nil) {
        if let epoch, epoch != activityEpoch { return }
        let left = (activityWatchCounts[memberID] ?? 0) - 1
        if left > 0 { activityWatchCounts[memberID] = left; return }
        activityWatchCounts[memberID] = nil
        openActivityMembers.remove(memberID); activityTokens[memberID] = nil
        activities[memberID] = nil; activityErrors[memberID] = nil
    }
    func refreshActivity() async { await enqueueRefresh(.activity, immediate: true) }

    func watchDeliveryNotices(memberID: String, owner: UUID) { deliveryWatchers[owner] = memberID }
    func unwatchDeliveryNotices(owner: UUID) { deliveryWatchers.removeValue(forKey: owner) }

    private func readActivities() async {
        guard foreground, let api, connectionStatus == .connected else { return }
        let epoch = generation, projectEpoch = projectGeneration, phase = foregroundGeneration
        for memberID in openActivityMembers {
            let activityToken = activityTokens[memberID], seen = activityRevisions[memberID], top = activities[memberID]?.first?.id
            do {
                let items = try await api.activity(memberID: memberID)
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration else { return }
                guard openActivityMembers.contains(memberID), activityTokens[memberID] == activityToken else { continue }
                var sorted = items.sorted { $0.id > $1.id }
                // 읽는 동안 이벤트로 끼운 줄(읽기 전의 맨 위보다도, 이 응답보다도 새것)은 지우지 않는다.
                if activityRevisions[memberID] != seen, let rows = activities[memberID] {
                    let floor = max(top ?? .min, sorted.first?.id ?? .min)
                    let newer = rows.filter { $0.id > floor }
                    if !newer.isEmpty { sorted = Array((newer + sorted).prefix(100)) }
                }
                // 같은 목록을 통째로 바꿔 다시 그리지 않는다.
                if activities[memberID].map({ ActivityList.same($0, sorted) }) != true { activities[memberID] = sorted }
                if activityErrors[memberID] != nil { activityErrors[memberID] = nil }
            } catch {
                guard !Task.isCancelled, epoch == generation, projectEpoch == projectGeneration, phase == foregroundGeneration else { return }
                if (error as? APIError)?.status == 401 { handle(error); return }
                if openActivityMembers.contains(memberID), activityTokens[memberID] == activityToken {
                    activityErrors[memberID] = friendlyLoadError(error, what: "활동", verb: "읽지")
                }
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
}
