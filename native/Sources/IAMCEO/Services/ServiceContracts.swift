import Foundation

/// Contract declarations only. APIClient adopts these when W2 adds the transport.
protocol MessageHistoryService: Sendable {
    func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage
    func archivedMessagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage
    func message(id: String) async throws -> Message
    func messagesAround(projectID: String, messageID: String, limit: Int) async throws -> [Message]
}

protocol ProjectManagementService: Sendable {
    func archivedProjects() async throws -> [Project]
    func patchProject(id: String, request: PatchProjectRequest) async throws -> Project
    func archiveState(projectID: String) async throws -> ProjectState
}

@MainActor protocol ProjectManagementStore: AnyObject {
    func loadArchivedProjects() async
    @discardableResult func patchProject(id: String, request: PatchProjectRequest) async -> Bool
}

protocol SyncService: Sendable {
    func capabilities() async throws -> ServerCapabilities
    func sync(projectID: String?) async throws -> SyncSnapshot
}

protocol DeliveryNoticeService: Sendable {
    func deliveryNotices(memberID: String, before: String?, limit: Int) async throws -> DeliveryNoticePage
    func recoverDelivery(id: String, request: DeliveryRecoveryRequest) async throws -> DeliveryRecoveryResult
}

protocol OperationService: Sendable {
    func operation(id: String) async throws -> OperationReceipt
    func freshSession(memberID: String, request: FreshSessionRequest) async throws -> OperationReceipt
    func terminalControl(memberID: String, request: TerminalControlV2Request) async throws -> OperationReceipt
    func patchSettings(request: SettingsPatchRequest, revision: Int) async throws -> SettingsWriteResult
    func patchMember(id: String, request: PatchMemberRequest, revision: Int) async throws -> MemberConfigWriteResult
    func patchTodo(id: String, request: TodoPatchRequest, revision: Int) async throws -> TodoWriteResult
}

protocol RealtimeTransport: Sendable {
    func receive() async throws -> Data
    func close() async
}

protocol RealtimeTransportFactory: Sendable {
    func connect(request: URLRequest) async throws -> any RealtimeTransport
}

protocol PushService: Sendable {
    func pushStatus() async throws -> PushStatus
    func pushDevices() async throws -> PushDeviceList
    func pushDevice(id: String) async throws -> PushDevice
    func registerPushDevice(id: String, request: PushRegistrationRequest) async throws -> PushDevice
    func patchPushDevice(id: String, request: PushDevicePatchRequest) async throws -> PushDevice
    func revokePushDevice(id: String, revision: Int) async throws
    func testPushDevice(id: String, request: PushTestRequest) async throws -> PushTestResult
    func pushTarget(eventID: String) async throws -> PushEventTarget
}

/// Missing keys preserve the server value; false and empty strings remain explicit values.
struct PatchProjectRequest: Encodable, Sendable {
    var name: String? = nil
    var cwd: String? = nil
    var runnerEnabled: Bool? = nil
    var now: String? = nil
    var archived: Bool? = nil
}

/// A rank patch differs from RankConfig: omitted preserves, null clears the override.
enum PatchValue<Value: Encodable & Sendable>: Encodable, Sendable {
    case null
    case value(Value)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .value(let value): try c.encode(value)
        }
    }
}

struct RankConfigPatch: Encodable, Sendable {
    var model: PatchValue<String>? = nil
    var effort: PatchValue<String>? = nil
}

struct SettingsPatchRequest: Encodable, Sendable {
    var permissionMode: String? = nil
    var ranks: [String: RankConfigPatch]? = nil
    var codexRanks: [String: RankConfigPatch]? = nil
    var maxConcurrentTurns: Int? = nil
    var compactAtPct: Int? = nil
    var contextWindowDefault: Int? = nil
    var contextWindows: [String: Int]? = nil
    var maxAwakeWorkers: Int? = nil
    var notifyMac: Bool? = nil
    var boardTidyHours: Double? = nil
    /// Sent as true once, with the mode the owner picked on the first-run choice. Never sent as false.
    var permissionAcknowledged: Bool? = nil
    /// "ko" | "en". Only sent when changed, which the settings screen allows only on a server that reports it.
    var reportLanguage: String? = nil
}

struct TodoPatchRequest: Encodable, Sendable { let done: Bool }

struct FreshSessionRequest: Encodable, Sendable {
    let operationId: String
    let expectedSessionGeneration: Int
}

enum TerminalKey: String, Codable, Sendable {
    case enter, up, down, esc, tab, controlC = "ctrl+c", backspace
}

enum TerminalAction: String, Codable, Sendable {
    case claim, release, input, key
}

struct TerminalControlV2Request: Encodable, Sendable {
    let action: TerminalAction
    let operationId: String
    let expectedSessionGeneration: Int
    let claimId: String
    var inputSequence: Int? = nil
    var text: String? = nil
    var key: TerminalKey? = nil

    private enum CodingKeys: String, CodingKey {
        case action, operationId, expectedSessionGeneration, claimId, inputSequence, text, key
    }
    func encode(to encoder: Encoder) throws {
        switch action {
        case .claim, .release:
            guard inputSequence == nil, text == nil, key == nil else {
                throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Lease actions cannot contain input"))
            }
        case .input:
            guard let inputSequence, inputSequence > 0, text != nil, key == nil else {
                throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Input requires sequence and text"))
            }
        case .key:
            guard let inputSequence, inputSequence > 0, key != nil, text == nil else {
                throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Key requires sequence and key"))
            }
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(action, forKey: .action)
        try c.encode(operationId, forKey: .operationId)
        try c.encode(expectedSessionGeneration, forKey: .expectedSessionGeneration)
        try c.encode(claimId, forKey: .claimId)
        try c.encodeIfPresent(inputSequence, forKey: .inputSequence)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(key, forKey: .key)
    }
}

/// Decode the error code without inferring it from localized error messages.
/// W2 must add stored `code: String?` to APIClient.swift's existing APIError and forward it.
struct APIErrorResponse: Decodable, Sendable {
    let error: String?
    let message: String?
    let code: String?
}
