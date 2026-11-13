import Foundation

// AppStore 의 끊김·재시작·망 변화 처리. 판정의 근거와 규칙은 ConnectionHealth(값 타입)에 있고, 여기서는 시계와 작업(Task)을
// 돌려 화면이 읽는 값(showsOffline, isRestarting, isCheckingConnection, connectionIssue, connectionStatus)을 바꾼다.
// 낡은 작업은 지금처럼 세대 토큰(generation, foregroundGeneration)으로 버린다.
extension AppStore {
    var retryCap: Double { health.retryCap(host: api?.endpoint.url.host) }

    private func socketIsHealthy(at now: Duration) -> Bool {
        socketHello && socketTask != nil && lastSocketFrame.map { now - $0 < .seconds(20) } == true
    }

    func markUnreachable(_ error: Error) async {
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, api != nil, bootstrap != nil else { return }
        health.recordTransportFailure(error, at: now)
        connectionIssue = error.localizedDescription
        clearReadError()
        if !socketIsHealthy(at: now) { isRevalidating = true; isCheckingConnection = true }
        await evaluateOffline()
    }

    private func evaluateOffline() async {
        offlineTask?.cancel(); offlineTask = nil
        guard foreground, !isRestarting, health.transportFailures >= 2, let firstTransportFailure = health.firstTransportFailure else { return }
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard epoch == generation, phase == foregroundGeneration, foreground, !isRestarting,
              health.transportFailures >= 2, health.firstTransportFailure == firstTransportFailure else { return }
        let deadline = health.offlineDeadline(from: firstTransportFailure,
                                              healthySocketFrame: socketIsHealthy(at: now) ? lastSocketFrame : nil, showsOffline: showsOffline)
        if now >= deadline {
            setOffline(true, at: now, reason: health.transportFailureReason, duration: now - firstTransportFailure)
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
        showsOffline = value; health.offlineChangedAt = now
        let seconds = Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
        Self.connectionLogger.notice("showsOffline=\(value, privacy: .public) reason=\(reason, privacy: .public) duration_seconds=\(seconds, privacy: .public)")
    }

    func markReachable(at now: Duration) {
        health.transportFailures = 0; health.firstTransportFailure = nil
        offlineTask?.cancel(); offlineTask = nil
        resumeNoticeTask?.cancel(); resumeNoticeTask = nil
        connectionIssue = nil; isCheckingConnection = false; health.retriedConsistencyFailure = false
        health.answeredFailure = false; unreadableFailures = 0
        isRestarting = false; health.restartDeadline = nil; health.restartWindowUsed = false
        restartTask?.cancel(); restartTask = nil
        let wasDisconnected = connectionStatus == .disconnected
        connectionStatus = .connected
        if showsOffline, let changed = health.offlineChangedAt, now < changed + .seconds(2) {
            let epoch = generation
            offlineTask = Task { [weak self, syncClock] in
                do { try await syncClock.sleep(for: changed + .seconds(2) - now) } catch { return }
                let recoveredAt = await syncClock.now()
                guard let self, !Task.isCancelled, epoch == generation, health.transportFailures == 0, health.offlineChangedAt == changed else { return }
                setOffline(false, at: recoveredAt, reason: "sync_recovered", duration: recoveredAt - changed)
            }
        } else if showsOffline {
            setOffline(false, at: now, reason: "sync_recovered", duration: now - (health.offlineChangedAt ?? now))
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

    func scheduleSyncRetry(after delay: Duration) {
        guard foreground, api != nil, syncRetryTask == nil else { return }
        let epoch = generation, phase = foregroundGeneration
        syncRetryTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            syncRetryTask = nil
            let now = await syncClock.now()
            guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground else { return }
            if isRestarting || health.foregroundGraceUntil.map({ now < $0 }) == true { nextSnapshotAt = .zero }
            await enqueueRefresh(.snapshot, immediate: true)
        }
    }

    func beginRestart() async {
        guard !health.restartWindowUsed else { return }
        let epoch = generation, phase = foregroundGeneration
        let now = await syncClock.now()
        guard !Task.isCancelled, epoch == generation, phase == foregroundGeneration, !health.restartWindowUsed else { return }
        health.restartWindowUsed = true; isRestarting = true; isRevalidating = true; isCheckingConnection = false
        health.transportFailures = 0; health.firstTransportFailure = nil
        offlineTask?.cancel(); offlineTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
        fallbackTask?.cancel(); fallbackTask = nil
        let deadline = now + .seconds(30)
        health.restartDeadline = deadline
        if socketTask == nil { socketFailed() }
        restartTask = Task { [weak self, syncClock] in
            do { try await syncClock.sleep(for: .seconds(30)) } catch { return }
            guard let self, !Task.isCancelled, health.restartDeadline == deadline else { return }
            isRestarting = false; health.restartDeadline = nil; restartTask = nil
            isCheckingConnection = true
            scheduleSyncRetry(after: .zero)
        }
    }

    func resetConnectionEvidence() {
        offlineTask?.cancel(); offlineTask = nil
        restartTask?.cancel(); restartTask = nil
        health.restartDeadline = nil; health.restartWindowUsed = false; isRestarting = false
        health.transportFailures = 0; health.firstTransportFailure = nil; health.foregroundGraceUntil = nil; health.retriedConsistencyFailure = false
        health.answeredFailure = false; unreadableFailures = 0
        isCheckingConnection = false
        if showsOffline {
            // Logout/host replacement ends the old connection's display lifetime.
            setOffline(false, at: .seconds(ProcessInfo.processInfo.systemUptime), reason: "session_ended", duration: .zero)
        }
        health.offlineChangedAt = nil
    }

    /// `interfaces`는 지금 쓸 수 있는 망 목록의 서명이다. 끊기지 않고 길만 바뀐 것(Wi-Fi 전환, VPN 터널 복귀)을 알아본다.
    func networkPathChanged(satisfied: Bool, interfaces: String? = nil) {
        let (restored, rerouted) = health.notePath(satisfied: satisfied, interfaces: interfaces)
        guard restored || rerouted, foreground else { return }
        if api == nil {
            // 첫 접속이 망 때문에 실패해 있었다면 기다리지 않고 바로 다시 붙는다.
            if connectionStatus == .failed, retryableConnect != nil { scheduleConnectRetry(immediately: true) }
            return
        }
        if restored { resetPathBackoff() }
        let epoch = generation, phase = foregroundGeneration
        pathChangeTask?.cancel()
        pathChangeTask = Task { [weak self, syncClock] in
            // 길이 바뀔 때는 알림이 연달아 온다. 잠깐 모아서 한 번만 다시 붙는다.
            if !restored { do { try await syncClock.sleep(for: .milliseconds(300)) } catch { return } }
            guard let self, !Task.isCancelled, epoch == generation, phase == foregroundGeneration, foreground, api != nil else { return }
            pathChangeTask = nil
            if !restored { resetPathBackoff() }
            let now = await syncClock.now()
            guard epoch == generation, phase == foregroundGeneration, foreground else { return }
            // 길이 바뀌면 예전 소켓은 조용히 죽어 있을 수 있어 건강해 보여도 새로 연다.
            if !restored || !socketIsHealthy(at: now) { stopSocket(); startSocket() }
            await enqueueRefresh(.all, immediate: true)
        }
    }

    private func resetPathBackoff() {
        socketFailures = 0; restFailures = 0
        reconnectTask?.cancel(); reconnectTask = nil
        syncRetryTask?.cancel(); syncRetryTask = nil
        nextSnapshotAt = .zero
    }
}
