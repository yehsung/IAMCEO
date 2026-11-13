import Foundation
import Observation

enum SubmissionError: Error, Equatable {
    case unresolvedAttempt(String)
    case invalidTransition
    case mismatchedResult
}

enum MessageSubmissionStatus: String, Codable, Sendable {
    case prepared, checking, notAccepted, accepted, refused
}

enum MessageFailureDisposition: String, Codable, Sendable { case retained, restored, dismissed }

struct MessageSubmission: Codable, Sendable, Identifiable {
    let id: String
    let namespace: String
    let projectID: String
    let targetMemberID: String?
    let draft: DraftSnapshot
    let contextFileId: String?
    var status: MessageSubmissionStatus = .prepared
    var message: Message?
    var draftConsumed = false
    // Optional fields preserve attempts written before immediate composer clearing.
    var handoffID: String?
    var handoffDraft: DraftSnapshot?
    var restoredDraft: DraftSnapshot?
    var failureReason: String?
    var failureDisposition: MessageFailureDisposition?

    var retainsFailedMessage: Bool {
        failureDisposition == .retained || (failureDisposition == nil && (status == .refused || status == .notAccepted))
    }
    var failureText: String {
        String(localized: "보내지 못했습니다: \(failureReason ?? String(localized: "서버가 접수하지 않았습니다"))")
            + (failureDisposition == .restored ? String(localized: ". 글은 입력칸에 되돌려 두었습니다") : "")
    }
    var failurePreview: String { String(draft.text.prefix(while: { !$0.isNewline })) }

    var request: SendMessageRequest {
        SendMessageRequest(id: id, text: draft.text, targetMemberId: targetMemberID, attachmentIds: draft.attachments.map(\.id), contextFileId: contextFileId)
    }
}

struct TerminalInputSnapshot: Codable, Sendable {
    let namespace: String
    let memberID: String
    let revision: Int
    let text: String
}

struct TerminalSubmission: Codable, Sendable, Identifiable {
    let id: String
    let namespace: String
    let memberID: String
    let sessionGeneration: Int
    let claimID: String
    let action: TerminalAction
    let inputSequence: Int?
    let input: TerminalInputSnapshot?
    let key: TerminalKey?
    var status: OperationStatus = .pending
    var dispatched = false

    var request: TerminalControlV2Request {
        TerminalControlV2Request(action: action, operationId: id, expectedSessionGeneration: sessionGeneration,
                                 claimId: claimID, inputSequence: inputSequence, text: input?.text, key: key)
    }
}

/// Persists intent before any external write. Recovery only queries; it never submits or replays input.
@MainActor @Observable
final class SubmissionStore {
    private struct Input: Codable {
        var text = ""
        var revision = 0
    }
    private struct State: Codable {
        var messages: [String: MessageSubmission] = [:]
        var terminals: [String: TerminalSubmission] = [:]
        var inputs: [String: [String: Input]] = [:]
        var claims: [String: String] = [:]
        var sequences: [String: Int] = [:]
    }
    private var state: State
    @ObservationIgnored private let storage: LocalStateStorage
    @ObservationIgnored private var queries: Set<String> = []

    init(persist: Bool = true, storageURL: URL? = nil, defaults: UserDefaults? = nil) throws {
        storage = LocalStateStorage(enabled: persist, url: storageURL, defaults: defaults ?? .standard, key: "iamceo.submissions.v1")
        state = try storage.read(State.self) ?? State()
    }

    func messages(namespace: String) -> [MessageSubmission] {
        state.messages.values.filter { $0.namespace == namespace }.sorted { $0.id < $1.id }
    }
    func messageAttempt(id: String) -> MessageSubmission? { state.messages[id] }
    func terminalAttempt(id: String) -> TerminalSubmission? { state.terminals[id] }

    /// An edited draft cannot silently replace an unresolved first attempt.
    func prepareMessage(projectID: String, targetMemberID: String?, draft: DraftSnapshot, contextFileID: String? = nil, clearsDraft: Bool = false) throws -> MessageSubmission {
        if let existing = state.messages.values.first(where: {
            guard $0.namespace == draft.namespace, $0.draft.key == draft.key else { return false }
            // A definitive refusal ends the intent. Even an unchanged restoration is a new send.
            // Only receipt-confirmed absence below needs to preserve the original request ID.
            if $0.status == .refused { return false }
            if $0.failureDisposition == .retained || $0.failureDisposition == .dismissed { return false }
            if $0.failureDisposition == .restored {
                return $0.restoredDraft?.generation == draft.generation && $0.restoredDraft?.revision == draft.revision
            }
            return $0.status != .refused && ($0.status != .accepted || !$0.draftConsumed)
        }) {
            let expected = existing.restoredDraft ?? existing.draft
            guard existing.projectID == projectID, existing.targetMemberID == targetMemberID,
                  expected.generation == draft.generation, expected.revision == draft.revision else {
                throw SubmissionError.unresolvedAttempt(existing.id)
            }
            if existing.handoffID != nil, existing.status == .notAccepted {
                var retry = existing
                retry.status = .notAccepted
                retry.handoffID = UUID().uuidString; retry.handoffDraft = draft; retry.restoredDraft = nil
                retry.failureDisposition = nil
                retry.failureReason = nil
                try update { $0.messages[retry.id] = retry }
                return retry
            }
            return existing
        }
        var attempt = MessageSubmission(id: UUID().uuidString, namespace: draft.namespace, projectID: projectID,
                                        targetMemberID: targetMemberID, draft: draft, contextFileId: contextFileID)
        if clearsDraft { attempt.handoffID = UUID().uuidString; attempt.handoffDraft = draft }
        try update { state in
            // Retire restored notices atomically with the replacement intent. Retained originals
            // belong to a separate next draft and must keep their explicit recovery actions.
            for previous in state.messages.values where previous.namespace == draft.namespace
                && previous.draft.key == draft.key && previous.failureDisposition == .restored
                && (previous.status == .refused || previous.status == .notAccepted) {
                state.messages[previous.id]?.failureDisposition = .dismissed
            }
            state.messages[attempt.id] = attempt
        }
        return attempt
    }

    /// Call immediately before sending the returned immutable body. A crash from here requires a receipt query.
    /// Only an explicit v1 retry may bypass the query; it still returns the original ID and body.
    func beginMessage(id: String, allowUnconfirmedRetry: Bool = false) throws -> SendMessageRequest {
        guard var attempt = state.messages[id], [.prepared, .notAccepted].contains(attempt.status)
                || (attempt.status == .refused && attempt.retainsFailedMessage)
                || (allowUnconfirmedRetry && attempt.status == .checking) else {
            throw SubmissionError.invalidTransition
        }
        attempt.status = .checking
        try update { $0.messages[id] = attempt }
        return attempt.request
    }

    func acceptMessage(id: String, message: Message) throws {
        guard var attempt = state.messages[id], message.id == id, message.projectId == attempt.projectID,
              message.mine, message.targetMemberId == attempt.targetMemberID else { throw SubmissionError.mismatchedResult }
        let merged = message.mergingDelivery(from: attempt.message)
        // 이미 접수된 같은 내용을 다시 받으면 저장하지 않는다. 스냅샷마다 전체 기록을 다시 쓰지 않게 한다.
        if attempt.status == .accepted, attempt.message == merged { return }
        attempt.status = .accepted; attempt.message = merged
        try update { $0.messages[id] = attempt }
    }

    func refuseMessage(id: String, reason: String? = nil) throws {
        guard var attempt = state.messages[id], attempt.status != .accepted else { throw SubmissionError.invalidTransition }
        attempt.status = .refused
        if let reason { attempt.failureReason = reason }
        try update { $0.messages[id] = attempt }
    }

    @discardableResult func reconcileMessage(id: String, using service: any MessageHistoryService) async throws -> MessageSubmissionStatus {
        guard let attempt = state.messages[id] else { throw SubmissionError.invalidTransition }
        if attempt.status == .accepted || attempt.status == .refused || attempt.status == .notAccepted { return attempt.status }
        guard queries.insert("message:\(id)").inserted else { return attempt.status }
        defer { queries.remove("message:\(id)") }
        do { try acceptMessage(id: id, message: await service.message(id: id)) }
        catch let error as APIError where error.status == 404 {
            if var current = state.messages[id], current.status != .accepted, current.status != .refused {
                current.status = .notAccepted
                current.failureReason = String(localized: "서버가 접수하지 않았습니다")
                try update { $0.messages[id] = current }
            }
        }
        // Network/401/5xx/decoding errors propagate, preserving checking and the original ID.
        return state.messages[id]?.status ?? attempt.status
    }

    @discardableResult func detachMessage(id: String, drafts: DraftStore) throws -> Bool {
        guard let attempt = state.messages[id] else { throw SubmissionError.invalidTransition }
        if let handoffID = attempt.handoffID, let sent = attempt.handoffDraft {
            return try drafts.detachSubmission(sent, id: handoffID)
        }
        return false
    }

    func restoreMessage(id: String, drafts: DraftStore) throws {
        guard var attempt = state.messages[id], attempt.status == .refused || attempt.status == .notAccepted else {
            throw SubmissionError.invalidTransition
        }
        guard attempt.failureDisposition == nil else { return }
        // An atomic draft receipt may have reached disk before the submission receipt.
        if let handoffID = attempt.handoffID, let sent = attempt.handoffDraft {
            if let restored = drafts.restoredSubmission(sent, id: handoffID) {
                attempt.restoredDraft = restored
                attempt.failureDisposition = drafts.matches(restored) ? .restored : .retained
            } else if drafts.canRestoreSubmission(sent) || (drafts.matches(sent) && !drafts.hasEditor(for: sent)) {
                // The prepared-before-detach crash window is repaired before any editor is installed.
                if drafts.matches(sent) { try detachMessage(id: id, drafts: drafts) }
                if drafts.canRestoreSubmission(sent) {
                    attempt.restoredDraft = try drafts.restoreSubmission(sent, id: handoffID)
                    attempt.failureDisposition = .restored
                } else { attempt.failureDisposition = .retained }
            } else { attempt.failureDisposition = .retained }
        } else { attempt.failureDisposition = .retained }
        try update { $0.messages[id] = attempt }
    }

    func failureNotices(namespace: String, key: String, drafts: DraftStore) -> [MessageSubmission] {
        messages(namespace: namespace).compactMap { attempt in
            guard attempt.draft.key == key, attempt.status != .accepted else { return nil }
            if attempt.retainsFailedMessage {
                var visible = attempt
                visible.failureDisposition = .retained
                return visible
            }
            if attempt.failureDisposition == .restored, attempt.restoredDraft.map(drafts.matches) == true { return attempt }
            return nil
        }
    }

    func dismissMessageFailure(id: String) throws {
        guard var attempt = state.messages[id], attempt.status == .refused || attempt.status == .notAccepted else {
            throw SubmissionError.invalidTransition
        }
        attempt.failureDisposition = .dismissed
        attempt.status = .refused
        try update { $0.messages[id] = attempt }
    }

    func insertFailedMessage(id: String, drafts: DraftStore) throws {
        guard let attempt = state.messages[id], attempt.retainsFailedMessage,
              attempt.status == .refused || attempt.status == .notAccepted,
              attempt.namespace == drafts.namespace else { throw SubmissionError.invalidTransition }
        drafts.commitEditors(for: attempt.draft.key)
        let sent = attempt.handoffDraft ?? attempt.draft
        // The draft receipt makes a crash between insertion and dismissal idempotent.
        _ = try drafts.restoreSubmission(sent, id: "insert:\(attempt.id)")
        drafts.moveEditorsCaretToEnd(for: attempt.draft.key)
        try dismissMessageFailure(id: id)
    }

    /// Repair both crash windows (intent → clear and restore → intent receipt) before displaying drafts.
    func recoverMessageDrafts(drafts: DraftStore) throws {
        for attempt in state.messages.values where attempt.handoffID != nil || attempt.status == .refused {
            switch attempt.status {
            case .prepared:
                var unsent = attempt
                unsent.status = .notAccepted
                try update { $0.messages[attempt.id] = unsent }
                try restoreMessage(id: attempt.id, drafts: drafts)
            case .checking: try detachMessage(id: attempt.id, drafts: drafts)
            case .accepted: try consumeAccepted(id: attempt.id, drafts: drafts)
            case .notAccepted, .refused: try restoreMessage(id: attempt.id, drafts: drafts)
            }
        }
    }

    func consumeAccepted(id: String, drafts: DraftStore) throws {
        guard var attempt = state.messages[id], attempt.status == .accepted else { throw SubmissionError.invalidTransition }
        guard !attempt.draftConsumed else { return }
        if attempt.handoffID != nil { try detachMessage(id: id, drafts: drafts) }
        else { drafts.consumeSent(attempt.draft) }
        if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
        attempt.draftConsumed = true
        try update { $0.messages[id] = attempt }
    }

    /// 접수와 초안 정리가 끝난 기록, 닫은 실패 알림은 최근 것만 남긴다. 결과가 남은 기록은 지우지 않는다.
    /// 지운 기록의 초안 인수 영수증 ID를 돌려준다.
    @discardableResult func pruneMessageHistory(keeping recent: Int = 50) throws -> Set<String> {
        let finished = state.messages.values.filter {
            ($0.status == .accepted && $0.draftConsumed) || $0.failureDisposition == .dismissed
        }
        guard finished.count > max(0, recent) else { return [] }
        let obsolete = finished.sorted { ($0.message?.at ?? "", $0.id) > ($1.message?.at ?? "", $1.id) }.dropFirst(max(0, recent))
        try update { state in for attempt in obsolete { state.messages.removeValue(forKey: attempt.id) } }
        return Set(obsolete.flatMap { [$0.handoffID, "insert:\($0.id)"].compactMap { $0 } })
    }

    func terminalInput(namespace: String, memberID: String) -> TerminalInputSnapshot {
        let input = state.inputs[namespace]?[memberID] ?? Input()
        return TerminalInputSnapshot(namespace: namespace, memberID: memberID, revision: input.revision, text: input.text)
    }
    func setTerminalInput(_ text: String, namespace: String, memberID: String) throws {
        guard !terminalInput(namespace: namespace, memberID: memberID).text.utf8.elementsEqual(text.utf8) else { return }
        try update {
            var input = $0.inputs[namespace]?[memberID] ?? Input()
            input.revision += 1; input.text = text
            $0.inputs[namespace, default: [:]][memberID] = input
        }
    }

    /// The same client claim survives a lost claim response and process restart.
    func terminalClaim(namespace: String, memberID: String, sessionGeneration: Int) throws -> String {
        let key = claimKey(namespace: namespace, memberID: memberID, generation: sessionGeneration)
        if let id = state.claims[key] { return id }
        let id = UUID().uuidString
        try update { $0.claims[key] = id }
        return id
    }

    func prepareTerminal(namespace: String, memberID: String, sessionGeneration: Int,
                         action: TerminalAction, key: TerminalKey? = nil, claimID: String? = nil) throws -> TerminalSubmission {
        guard sessionGeneration >= 0, (action == .key) == (key != nil) else { throw SubmissionError.invalidTransition }
        if let pending = state.terminals.values.first(where: {
            $0.namespace == namespace && $0.memberID == memberID && ($0.status == .pending || $0.status == .unknown)
        }) { throw SubmissionError.unresolvedAttempt(pending.id) }
        let claim = try claimID ?? terminalClaim(namespace: namespace, memberID: memberID, sessionGeneration: sessionGeneration)
        let counter = claimKey(namespace: namespace, memberID: memberID, generation: sessionGeneration)
        let hasInput = action == .input || action == .key
        let sequence = hasInput ? (state.sequences[counter] ?? 0) + 1 : nil
        let attempt = TerminalSubmission(id: UUID().uuidString, namespace: namespace, memberID: memberID,
                                         sessionGeneration: sessionGeneration, claimID: claim, action: action,
                                         inputSequence: sequence, input: action == .input ? terminalInput(namespace: namespace, memberID: memberID) : nil, key: key)
        try update {
            if action == .claim, let claimID {
                if $0.claims[counter] != claimID { $0.sequences[counter] = 0 }
                $0.claims[counter] = claimID
            }
            $0.terminals[attempt.id] = attempt
            if let sequence { $0.sequences[counter] = sequence }
        }
        return attempt
    }

    func beginTerminal(id: String) throws -> TerminalControlV2Request {
        guard var attempt = state.terminals[id], !attempt.dispatched, attempt.status == .pending else {
            throw SubmissionError.invalidTransition
        }
        attempt.dispatched = true
        attempt.status = .unknown // Durable even if the process dies immediately after the physical write.
        try update { $0.terminals[id] = attempt }
        return attempt.request
    }

    func applyTerminalReceipt(_ receipt: OperationReceipt) throws {
        guard var attempt = state.terminals[receipt.operationId], receipt.kind == .terminalControl,
              receipt.memberId == attempt.memberID else { throw SubmissionError.mismatchedResult }
        if attempt.status == .applied || attempt.status == .refused { return }
        if receipt.status == .applied {
            guard case .terminalControl(let result) = receipt.result, result.memberId == attempt.memberID,
                  result.claimId == attempt.claimID, result.sessionGeneration == attempt.sessionGeneration,
                  result.action == attempt.action.rawValue, result.inputSequence == attempt.inputSequence else {
                throw SubmissionError.mismatchedResult
            }
        }
        attempt.status = receipt.status
        try update {
            $0.terminals[attempt.id] = attempt
            if receipt.status == .applied, let sent = attempt.input,
               $0.inputs[sent.namespace]?[sent.memberID]?.revision == sent.revision {
                $0.inputs[sent.namespace]?[sent.memberID]?.text = ""
                $0.inputs[sent.namespace]?[sent.memberID]?.revision += 1
            }
        }
    }

    /// Prune only final attempts no longer referenced by the write journal. Unknown input is never discarded.
    func pruneTerminalHistory(keeping ids: Set<String>) throws {
        let obsolete = state.terminals.values.filter { !ids.contains($0.id) && ($0.status == .applied || $0.status == .refused) }.map(\.id)
        guard !obsolete.isEmpty else { return }
        try update { state in for id in obsolete { state.terminals.removeValue(forKey: id) } }
    }

    func reconcileTerminal(id: String, using service: any OperationService) async throws {
        guard state.terminals[id] != nil else { throw SubmissionError.invalidTransition }
        guard queries.insert("terminal:\(id)").inserted else { return }
        defer { queries.remove("terminal:\(id)") }
        try applyTerminalReceipt(await service.operation(id: id))
    }

    private func claimKey(namespace: String, memberID: String, generation: Int) -> String {
        "\(namespace.utf8.count):\(namespace)|\(memberID.utf8.count):\(memberID)|\(generation)"
    }
    private func update(_ change: (inout State) -> Void) throws {
        var next = state
        change(&next)
        try storage.write(next) // Fail closed: do not expose a sendable attempt if durability fails.
        state = next
    }
}
