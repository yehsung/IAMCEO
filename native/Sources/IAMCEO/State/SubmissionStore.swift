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

struct MessageSubmission: Codable, Sendable, Identifiable {
    let id: String
    let namespace: String
    let projectID: String
    let targetMemberID: String?
    let draft: DraftSnapshot
    var status: MessageSubmissionStatus = .prepared
    var message: Message?
    var draftConsumed = false

    var request: SendMessageRequest {
        SendMessageRequest(id: id, text: draft.text, targetMemberId: targetMemberID, attachmentIds: draft.attachments.map(\.id))
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
    func prepareMessage(projectID: String, targetMemberID: String?, draft: DraftSnapshot) throws -> MessageSubmission {
        if let existing = state.messages.values.first(where: {
            $0.namespace == draft.namespace && $0.draft.key == draft.key && $0.status != .refused
                && ($0.status != .accepted || !$0.draftConsumed)
        }) {
            guard existing.projectID == projectID, existing.targetMemberID == targetMemberID,
                  existing.draft.generation == draft.generation, existing.draft.revision == draft.revision else {
                throw SubmissionError.unresolvedAttempt(existing.id)
            }
            return existing
        }
        let attempt = MessageSubmission(id: UUID().uuidString, namespace: draft.namespace, projectID: projectID,
                                        targetMemberID: targetMemberID, draft: draft)
        try update { $0.messages[attempt.id] = attempt }
        return attempt
    }

    /// Call immediately before sending the returned immutable body. A crash from here requires a receipt query.
    func beginMessage(id: String) throws -> SendMessageRequest {
        guard var attempt = state.messages[id], [.prepared, .notAccepted].contains(attempt.status) else {
            throw SubmissionError.invalidTransition
        }
        attempt.status = .checking
        try update { $0.messages[id] = attempt }
        return attempt.request
    }

    func acceptMessage(id: String, message: Message) throws {
        guard var attempt = state.messages[id], message.id == id, message.projectId == attempt.projectID,
              message.mine, message.targetMemberId == attempt.targetMemberID else { throw SubmissionError.mismatchedResult }
        attempt.status = .accepted; attempt.message = message
        try update { $0.messages[id] = attempt }
    }

    func refuseMessage(id: String) throws {
        guard var attempt = state.messages[id], attempt.status != .accepted else { throw SubmissionError.invalidTransition }
        attempt.status = .refused
        try update { $0.messages[id] = attempt }
    }

    @discardableResult func reconcileMessage(id: String, using service: any MessageHistoryService) async throws -> MessageSubmissionStatus {
        guard let attempt = state.messages[id] else { throw SubmissionError.invalidTransition }
        if attempt.status == .accepted || attempt.status == .refused { return attempt.status }
        guard queries.insert("message:\(id)").inserted else { return attempt.status }
        defer { queries.remove("message:\(id)") }
        do { try acceptMessage(id: id, message: await service.message(id: id)) }
        catch let error as APIError where error.status == 404 {
            if var current = state.messages[id], current.status != .accepted, current.status != .refused {
                current.status = .notAccepted
                try update { $0.messages[id] = current }
            }
        }
        // Network/401/5xx/decoding errors propagate, preserving checking and the original ID.
        return state.messages[id]!.status
    }

    func consumeAccepted(id: String, drafts: DraftStore) throws {
        guard var attempt = state.messages[id], attempt.status == .accepted else { throw SubmissionError.invalidTransition }
        guard !attempt.draftConsumed else { return }
        drafts.consumeSent(attempt.draft)
        if let error = drafts.persistenceError { throw APIError(status: 0, message: error) }
        attempt.draftConsumed = true
        try update { $0.messages[id] = attempt }
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
                         action: TerminalAction, key: TerminalKey? = nil) throws -> TerminalSubmission {
        guard sessionGeneration >= 0, (action == .key) == (key != nil) else { throw SubmissionError.invalidTransition }
        if let pending = state.terminals.values.first(where: {
            $0.namespace == namespace && $0.memberID == memberID && ($0.status == .pending || $0.status == .unknown)
        }) { throw SubmissionError.unresolvedAttempt(pending.id) }
        let claim = try terminalClaim(namespace: namespace, memberID: memberID, sessionGeneration: sessionGeneration)
        let counter = claimKey(namespace: namespace, memberID: memberID, generation: sessionGeneration)
        let hasInput = action == .input || action == .key
        let sequence = hasInput ? (state.sequences[counter] ?? 0) + 1 : nil
        let attempt = TerminalSubmission(id: UUID().uuidString, namespace: namespace, memberID: memberID,
                                         sessionGeneration: sessionGeneration, claimID: claim, action: action,
                                         inputSequence: sequence, input: action == .input ? terminalInput(namespace: namespace, memberID: memberID) : nil, key: key)
        try update {
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
