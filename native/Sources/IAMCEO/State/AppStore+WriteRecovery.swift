import Foundation

// AppStore 의 쓰기 저널과 복구. 응답을 잃은 쓰기는 기기에 남긴 기록(AppWriteJournal)과 고정 작업 ID 로 결과를 조회하고,
// 결과를 모르는 입력은 다시 보내지 않는다. 결과를 끝내 확인하지 못한 기록은 정해진 시간이 지나면 닫는다.
// 쓰기 판정에 쓰는 revision 은 화면 자료와 같은 스냅샷(/api/sync)에서 받는다(applyWriteContext).
extension AppStore {
    /// 쓰기 요청 제한 시간(20초)을 넉넉히 넘긴 시간. 이만큼 지나도 서버 상태가 그대로면 요청은 도착하지 않은 것이다.
    static let lostWriteLimit: Double = 60

    func saveJournal(_ change: (inout AppWriteJournal) -> Void) throws {
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
    static func scoped(_ namespace: String, _ id: String) -> String { "\(namespace.utf8.count):\(namespace)|\(id)" }
    static func definiteRefusal(_ error: Error?) -> Bool {
        guard let error = error as? APIError else { return false }
        return [400, 401, 403, 404, 409, 422, 501].contains(error.status)
            && error.code != "OPERATION_UNKNOWN" && error.code != "RESULT_UNKNOWN"
    }

    /// Reconcile without replaying physical input. A cancelled sheet claim is released after its receipt is recovered.
    func recoverWrites() async {
        guard canWrite, !recoveryInFlight else { return }
        recoveryInFlight = true
        defer { recoveryInFlight = false }
        let epoch = generation, namespace = writeNamespace
        pruneFinishedRecoveries()
        for operation in Array(journal.deliveryRecoveries?.values ?? Dictionary<String, PendingDeliveryRecovery>().values)
            where operation.namespace == namespace && operation.projectID == selectedProjectID && operation.result == nil && !operation.refused {
            deliveryChecking.insert(operation.deliveryID)
            await loadDeliveryNotices(memberID: operation.memberID)
            guard epoch == generation, canWrite else { return }
            settleDeliveryRecovery(operation)
        }
        for operation in Array(journal.unassignedRecoveries?.values ?? Dictionary<String, PendingUnassignedRecovery>().values)
            where operation.namespace == namespace && operation.projectID == selectedProjectID && operation.result == nil && !operation.refused {
            deliveryChecking.insert("message:\(operation.messageID)")
            await loadUnassignedDeliveries()
            guard epoch == generation, canWrite else { return }
            settleUnassignedRecovery(operation)
        }
        if let submissions {
            do { drafts.pruneHandoffs(try submissions.pruneMessageHistory()) }
            catch { handle(error); return }
        }
        guard strictWriteContract, let submissions else { return }
        // 할 일이 남은 기록만 본다. 접수와 초안 정리가 끝난 기록을 스냅샷마다 다시 저장하지 않는다.
        for attempt in submissions.messages(namespace: namespace) where attempt.status == .checking
            || (attempt.status == .accepted && !attempt.draftConsumed)
            || (attempt.status == .notAccepted && attempt.failureDisposition == nil) {
            guard !isSending(projectID: attempt.projectID, targetMemberID: attempt.targetMemberID) else { continue }
            // 리뷰 safety-3: 같은 주소에 다른 서버가 떠 있으면 그 서버로 보낸 글이 아니다. 묻지도 정리하지도 않고 '확인 중'으로 둔다.
            guard sentToCurrentServer(attempt) else { continue }
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
            // 같은 작업의 '확인 중' 문구는 한 번만 띄운다. 스냅샷마다 되살리지 않는다.
            await reconcileOperation(operation, announce: announcedUnresolved.insert(operation.id).inserted)
            guard epoch == generation, canWrite else { return }
            expireStaleOperation(operation.id)
        }
        // Retry unfinished cleanup on every recovery, even when leaseReceiptOrder already consumed the claim.
        _ = await recoverCancelledTerminalClaims()
    }

    /// 응답을 잃은 전달 조치를 요청 제한 시간이 한참 지난 뒤 닫는다. 닫지 않으면 그 항목의 버튼이 이 기기에서 영영 꺼진 채 남는다.
    /// 닫은 뒤에는 방금 다시 읽은 서버 상태가 기준이다. 서버는 expectedVersion으로 옛 상태를 본 조치를 거절한다.
    private func settleDeliveryRecovery(_ tracked: PendingDeliveryRecovery) {
        let key = Self.scoped(tracked.namespace, tracked.deliveryID), now = wallClock()
        guard journal.deliveryRecoveries?[key]?.id == tracked.id, !pendingActions.contains("delivery:\(tracked.deliveryID)") else { return }
        // 예전 기록에는 시각이 없다. 처음 본 때부터 센다.
        if tracked.createdAt == nil { _ = try? saveJournal { $0.deliveryRecoveries?[key]?.createdAt = now } }
        // 그 전까지는 같은 조치를 같은 작업 ID로 다시 보내 서버가 기억한 결과를 받을 수 있게 둔다.
        guard now - (tracked.createdAt ?? now) >= Self.lostWriteLimit else { return }
        do {
            try saveJournal { $0.deliveryRecoveries?.removeValue(forKey: key) }
            deliveryChecking.remove(tracked.deliveryID)
        } catch { handle(error) }
    }

    private func settleUnassignedRecovery(_ tracked: PendingUnassignedRecovery) {
        let key = Self.scoped(tracked.namespace, tracked.messageID), now = wallClock()
        guard journal.unassignedRecoveries?[key]?.id == tracked.id, !pendingActions.contains("unassigned:\(tracked.messageID)") else { return }
        if tracked.createdAt == nil { _ = try? saveJournal { $0.unassignedRecoveries?[key]?.createdAt = now } }
        guard now - (tracked.createdAt ?? now) >= Self.lostWriteLimit else { return }
        do {
            try saveJournal { $0.unassignedRecoveries?.removeValue(forKey: key) }
            deliveryChecking.remove("message:\(tracked.messageID)")
        } catch { handle(error) }
    }

    /// 끝난 전달 조치 기록은 다시 읽는 곳이 없다. 쌓이지 않게 가끔 비운다.
    private func pruneFinishedRecoveries() {
        let deliveries = journal.deliveryRecoveries?.filter { $0.value.result != nil || $0.value.refused }.map(\.key) ?? []
        let unassigned = journal.unassignedRecoveries?.filter { $0.value.result != nil || $0.value.refused }.map(\.key) ?? []
        guard deliveries.count + unassigned.count > 50 else { return }
        _ = try? saveJournal { journal in
            for key in deliveries { journal.deliveryRecoveries?.removeValue(forKey: key) }
            for key in unassigned { journal.unassignedRecoveries?.removeValue(forKey: key) }
        }
    }

    func reconcileOperation(_ tracked: TrackedOperation, announce: Bool = true) async {
        guard let api, canWrite, tracked.namespace == writeNamespace else { return }
        let epoch = generation
        do {
            let receipt = try await api.operation(id: tracked.id)
            guard epoch == generation else { return }
            absentOperations.remove(tracked.id)
            try applyReceipt(receipt, tracked: tracked, announce: announce)
        } catch {
            guard epoch == generation else { return }
            // '서버에 기록 없음'은 바로 앞 조회가 404였을 때만 믿는다. 다른 실패 뒤에는 예전 404로 닫지 않는다.
            if (error as? APIError)?.status == 404 { absentOperations.insert(tracked.id) } else { absentOperations.remove(tracked.id) }
            if (error as? APIError)?.status == 401 { handle(error) }
            else if announce, tracked.status == .unknown || tracked.status == .pending {
                errorMessage = String(localized: "작업 결과 확인 중입니다. 미확인 작업은 재실행하지 않습니다.")
            }
        }
    }

    /// 결과를 끝내 확인하지 못한 작업을 다시 보내지 않고 닫는다. 닫지 않으면 그 직원의 직접 조작·새 세션이
    /// 이 기기에서 영영 막힌다. 닫은 뒤에 나가는 것은 대표가 새로 누른 조작뿐이다.
    @discardableResult func expireStaleOperation(_ id: String) -> Bool {
        guard let tracked = journal.operations[id], tracked.namespace == writeNamespace,
              tracked.status == .unknown || tracked.status == .pending else { return false }
        let now = wallClock()
        // 예전 기록에는 시각이 없다. 처음 본 때부터 센다.
        if tracked.createdAt == nil { _ = try? saveJournal { $0.operations[id]?.createdAt = now } }
        let age = now - (tracked.createdAt ?? now)
        // 세션 세대가 바뀌었으면 그 터미널은 이미 없다. 새 세션 작업은 세대가 바뀌는 것이 곧 결과라서 이 규칙을 쓰지 않는다.
        let sessionGone = tracked.kind == .terminalControl
            && writeRevisions?.members?[tracked.memberID].map { $0.sessionGeneration != tracked.sessionGeneration } ?? false
        // 서버에 기록이 없고, 보내기 전에 멈췄거나 요청 제한 시간(조작 20초, 새 세션 150초)이 지났으면 도착하지 않은 것이다.
        let neverSent = tracked.kind == .terminalControl && submissions?.terminalAttempt(id: id)?.dispatched == false
        let notArrived = absentOperations.contains(id) && (neverSent || age >= (tracked.kind == .freshSession ? 180 : 60))
        // 조작권은 서버에서 5분이면 끝난다. 그 두 배가 지나도 결과가 없으면 더 기다리지 않는다.
        guard sessionGone || notArrived || age >= 600 else { return false }
        let receipt = OperationReceipt(operationId: id, kind: tracked.kind, memberId: tracked.memberID, status: .refused,
                                       error: String(localized: "결과를 확인하지 못해 닫았습니다. 필요하면 다시 시도해 주세요."))
        do {
            if tracked.kind == .terminalControl, submissions?.terminalAttempt(id: id) == nil {
                try saveJournal { $0.operations[id]?.status = .refused }
                operationResults[id] = receipt
            } else { try applyReceipt(receipt, tracked: tracked) }
        } catch { handle(error); return false }
        return true
    }

    func applyReceipt(_ receipt: OperationReceipt, tracked: TrackedOperation, announce: Bool = true) throws {
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
           let error = receipt.refusalError(), Self.leaseGone(error),
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
            if announce { errorMessage = String(localized: "작업 결과 확인 중입니다. 미확인 작업은 재실행하지 않습니다.") }
        } else if receipt.status == .refused, previousStatus != .refused {
            if tracked.kind == .terminalControl && terminalRefusalIsLocal(memberID: tracked.memberID, error: receipt.refusalError()) {
                terminalWindowNotices[tracked.memberID] = receipt.error
            } else { errorMessage = receipt.error ?? String(localized: "서버가 작업을 거부했습니다.") }
        }
    }

    func recordOperationFailure(_ tracked: TrackedOperation, error: Error?) async {
        if journal.operations[tracked.id]?.status == .applied { return }
        let status: OperationStatus = Self.definiteRefusal(error) ? .refused : .unknown
        let receipt = OperationReceipt(operationId: tracked.id, kind: tracked.kind, memberId: tracked.memberID,
                                       status: status, code: (error as? APIError)?.code, error: error?.localizedDescription, reason: (error as? APIError)?.reason)
        do {
            try applyReceipt(receipt, tracked: tracked)
            // Refresh conflicts only after the durable refusal, so recovery cannot query this finished write.
            if status == .refused, (error as? APIError)?.status == 409,
               !ServerCode.terminalMissing(error) { await refresh() }
        } catch { handle(error) }
    }

    /// All write revisions use the same atomic snapshot as the visible domain data.
    func refreshWriteContext() async {
        await discoverCapabilities()
        guard strictWriteContract else { return }
        await enqueueRefresh(.snapshot, immediate: true, allowPaused: true)
    }

    func applyWriteContext(_ snapshot: SyncSnapshot) throws {
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
            } else if !pendingActions.contains("todo:\(pending.id)"), let created = pending.createdAt, wallClock() - created >= Self.lostWriteLimit {
                // 요청 제한 시간을 한참 넘겨도 revision이 그대로면 도착하지 않은 변경이다. 닫아야 다시 누를 수 있다.
                try saveJournal { $0.todos.removeValue(forKey: Self.scoped(pending.namespace, pending.id)) }
                todoWrites[pending.id] = .notApplied
            } else {
                // 예전 기록에는 시각이 없다. 처음 본 때부터 센다.
                if pending.createdAt == nil { let now = wallClock(); try saveJournal { $0.todos[Self.scoped(pending.namespace, pending.id)]?.createdAt = now } }
                todoWrites[pending.id] = .checking
            }
        }
    }
}
