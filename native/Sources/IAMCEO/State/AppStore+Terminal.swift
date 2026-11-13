import Foundation
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

// AppStore 의 터미널 조작권: 깨우기, 시트마다의 조작권 받기·놓기(늦게 온 받기·닫기가 다음 시트의 조작권을 놓지 않게 줄 세운다),
// 입력·키, 승인 창 답하기. 조작권과 입력 결과는 쓰기 저널(AppStore+WriteRecovery.swift)로 확인하고 다시 보내지 않는다.
// 저장 값(terminalLeases, terminalWindows, terminalSession*, terminalReleases)은 AppStore.swift 에 있다.
extension AppStore {
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

    func terminalWindowNotice(memberID: String) -> String? { terminalWindowNotices[memberID] }
    func terminalWindowOpened(memberID: String, owner: UUID) { terminalWindows[owner] = memberID }
    func terminalWindowClosed(owner: UUID) {
        if let memberID = terminalWindows.removeValue(forKey: owner), !terminalWindows.values.contains(memberID) {
            terminalWindowNotices.removeValue(forKey: memberID)
        }
    }
    func terminalRefusalIsLocal(memberID: String, error: Error?) -> Bool {
        ServerCode.terminalMissing(error) && terminalWindows.values.contains(memberID)
    }

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
    func recoverCancelledTerminalClaims(memberID: String? = nil) async -> Bool {
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
            if let error = outcome.error as? APIError, ServerCode.leaseAlreadyReleased(reason: error.reason, message: error.message) {
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
    static func leaseGone(_ error: Error?) -> Bool {
        guard let error = error as? APIError else { return false }
        if error.status == 404 { return true }
        guard error.status == 409 else { return false }
        return ServerCode.leaseGone(code: error.code, reason: error.reason, message: error.message)
    }

    func releaseAllTerminals() {
        // Strict release is journaled and explicit. Dropping a connection must never replay an unknown input.
        guard !strictWriteContract, let api else { terminalLeases.removeAll(); return }
        let leases = terminalLeases
        terminalLeases.removeAll()
        // Sent right here, not from a later Task: by the time a deferred Task runs, whoever handed us the session may
        // have invalidated it, and creating a request on an invalidated session raises an Objective-C exception.
        for (memberID, lease) in leases {
            guard let id = lease.leaseId else { continue }
            api.releaseTerminalLeaseNow(memberID: memberID, leaseId: id)
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
            // 방금 닫힌 옛 작업은 더 막지 않는다. 이번에 누른 것은 새 작업으로 나간다.
            if !expireStaleOperation(previous.id) {
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
                                           order: (journal.operations.values.map(\.order).max() ?? -1) + 1, action: action,
                                           createdAt: Date().timeIntervalSince1970)
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
               ServerCode.leaseExpiredReceipt(receipt) {
                terminalLeases.removeValue(forKey: member.id); errorMessage = nil
                return true
            }
            if Self.leaseGone(result.error) { terminalLeases.removeValue(forKey: member.id) }
        } catch { if epoch == generation { handle(error) } }
        return false
    }
}
