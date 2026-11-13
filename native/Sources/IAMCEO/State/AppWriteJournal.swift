import Foundation

// 쓰기 저널: 응답을 잃은 쓰기를 다시 확인하려고 기기에 남기는 기록(AppStore 의 `iamceo.appWrites.v1`).
// 저장 형식이 곧 이 타입들의 Codable 이다. 필드 이름·타입을 바꾸면 이미 저장된 기록을 읽지 못한다.

struct TrackedOperation: Codable {
    let id: String
    let namespace: String
    let memberID: String
    let kind: OperationKind
    let sessionGeneration: Int
    let order: Int
    var action: TerminalAction? = nil
    var cancelledClaim: Bool? = nil
    var status: OperationStatus = .unknown
    var receipt: OperationReceipt? = nil // Optional for journals written before fix 11.
    var leaseEnded: Bool? = nil // A confirmed disappearance also fences historical lease restoration.
    var createdAt: Double? = nil // 예전 기록에는 없다. 결과 미확인 작업을 닫을 때의 기준 시각(초).
}
struct PendingTodo: Codable {
    let id: String
    let namespace: String
    let revision: Int
    let done: Bool
    let note: String?
    let fileIds: [String]?
    var dropReason: String? = nil
    var dropped: Bool? = nil
    var createdAt: Double? = nil // 예전 기록에는 없다. 응답을 잃은 변경을 닫을 때의 기준 시각(초).
}
struct AppWriteJournal: Codable {
    var operations: [String: TrackedOperation] = [:]
    var todos: [String: PendingTodo] = [:]
    var unassignedRecoveries: [String: PendingUnassignedRecovery]? = nil
    var deliveryRecoveries: [String: PendingDeliveryRecovery]? = nil
    var projectChanges: [String: PendingProjectChange]? = nil
    var contextRequests: [String: PendingContextRequest]? = nil
    var serverEndpoints: [String: String]? = nil

    @discardableResult mutating func pruneTerminalHistory() -> Bool {
        let completed = operations.values.filter { $0.kind == .terminalControl && ($0.status == .applied || $0.status == .refused) }
            .sorted { ($0.order, $0.id) > ($1.order, $1.id) }
        var keep = Set(completed.prefix(64).map(\.id))
        // Keep one lease checkpoint per host/member, including a release tombstone.
        var checkpointMembers = Set<String>()
        for operation in completed where operation.status == .applied {
            let key = "\(operation.namespace.utf8.count):\(operation.namespace)|\(operation.memberID)"
            if checkpointMembers.insert(key).inserted { keep.insert(operation.id) }
        }
        // The current claim must survive >64 inputs so a later close can still persist its intent.
        // A release or a newer claim ends the previous active-claim checkpoint.
        var claimMembers = Set<String>()
        for operation in completed where operation.status == .applied && (operation.action == .claim || operation.action == .release) {
            let key = "\(operation.namespace.utf8.count):\(operation.namespace)|\(operation.memberID)"
            if claimMembers.insert(key).inserted, operation.action == .claim { keep.insert(operation.id) }
        }
        for operation in completed where operation.cancelledClaim == true { keep.insert(operation.id) }
        let oldCount = operations.count
        for operation in completed where !keep.contains(operation.id) { operations.removeValue(forKey: operation.id) }
        return operations.count != oldCount
    }
}

struct PendingProjectChange: Codable {
    let id: UUID
    let namespace: String
    let projectID: String
    let name: String?
    let cwd: String?
    let runnerEnabled: Bool?
    let now: String?
    let archived: Bool?
    var createdAt: Double? = nil // 예전 기록에는 없다. 끝내 반영되지 않은 변경을 닫을 때의 기준 시각(초).
    init(namespace: String, projectID: String, request: PatchProjectRequest) {
        id = UUID()
        self.namespace = namespace; self.projectID = projectID
        name = request.name; cwd = request.cwd; runnerEnabled = request.runnerEnabled; now = request.now; archived = request.archived
    }
    func matches(_ project: Project) -> Bool {
        (name == nil || name?.trimmingCharacters(in: .whitespacesAndNewlines) == project.name)
            && (cwd == nil || Self.samePath(cwd!, project.cwd)) && (runnerEnabled == nil || runnerEnabled == project.runnerEnabled)
            && (now == nil || now == project.now) && (archived == nil || archived == project.archived)
    }
    /// 서버는 '~/…'를 자기 홈 아래 절대 경로로 펼치고 끝의 '/'를 떼어 돌려준다.
    static func samePath(_ requested: String, _ actual: String) -> Bool {
        func trimmed(_ path: String) -> String { path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path }
        let wanted = trimmed(requested), current = trimmed(actual)
        if wanted == current { return true }
        return wanted.hasPrefix("~/") && current.hasPrefix("/") && current.hasSuffix(String(wanted.dropFirst(1)))
    }
}
struct PendingContextRequest: Codable {
    let namespace: String
    let memberID: String
    let sessionID: String?
    let previousCompactionID: String?
}
struct PendingUnassignedRecovery: Codable {
    let id: String
    let namespace: String
    let projectID: String
    let messageID: String
    let version: Int
    let action: UnassignedRecoveryAction
    var result: UnassignedRecoveryResult? = nil
    var refused = false
    var createdAt: Double? = nil // 예전 기록에는 없다. 응답을 잃은 조치를 닫을 때의 기준 시각(초).
}
struct PendingDeliveryRecovery: Codable {
    let id: String
    let namespace: String
    let projectID: String
    let memberID: String
    let deliveryID: String
    let version: Int
    let action: DeliveryRecoveryAction
    let acceptDuplicateRisk: Bool
    var result: DeliveryRecoveryResult? = nil
    var refused = false
    var createdAt: Double? = nil // 예전 기록에는 없다. 응답을 잃은 조치를 닫을 때의 기준 시각(초).
}
