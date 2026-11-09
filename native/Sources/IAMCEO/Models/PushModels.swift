import Foundation

enum PushKind: String, SafeStringEnum {
    case decision, approvalWait = "approval_wait", error, reportComplete = "report_complete"
    case todoCreated = "todo_created", reportBlocked = "report_blocked", unknown
    static var supported: [PushKind] { [.decision, .approvalWait, .error, .reportComplete, .todoCreated, .reportBlocked] }
}
enum PushEnvironment: String, SafeStringEnum { case sandbox, production, unknown }
enum PushAuthorization: String, SafeStringEnum {
    case authorized, provisional, ephemeral, denied, notDetermined, unknown
    var permitsNotifications: Bool { [.authorized, .provisional, .ephemeral].contains(self) }
}
enum PushDeviceState: String, SafeStringEnum { case active, revoked, invalid, expired, unknown }
enum PushProviderState: String, SafeStringEnum {
    case ready, unconfigured, configurationError = "configuration_error"
    case temporarilyUnavailable = "temporarily_unavailable", unknown
}
enum PushDeliveryState: String, SafeStringEnum {
    case queued, sending, retry, accepted, cancelled, invalid, expired, failed, unknown
}

enum PushContract {
    static let bundleID = "com.yehsung.iamceo"
    static let reportGroupWindowMilliseconds = 120_000
}

struct PushPreferences: Codable, Sendable, Equatable {
    var decision: Bool = true
    var approvalWait: Bool = true
    var error: Bool = true
    var reportComplete: Bool = true
    var todoCreated: Bool = true
    var reportBlocked: Bool = true

    private enum CodingKeys: String, CodingKey {
        case decision, approvalWait = "approval_wait", error, reportComplete = "report_complete"
        case todoCreated = "todo_created", reportBlocked = "report_blocked"
    }
}
extension PushPreferences {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Constructor defaults are opt-in defaults, never invented server preferences.
        decision = try c.decodeIfPresent(Bool.self, forKey: .decision) ?? false
        approvalWait = try c.decodeIfPresent(Bool.self, forKey: .approvalWait) ?? false
        error = try c.decodeIfPresent(Bool.self, forKey: .error) ?? false
        reportComplete = try c.decodeIfPresent(Bool.self, forKey: .reportComplete) ?? false
        todoCreated = try c.decodeIfPresent(Bool.self, forKey: .todoCreated) ?? false
        reportBlocked = try c.decodeIfPresent(Bool.self, forKey: .reportBlocked) ?? false
    }
}
struct PushPreferencesPatch: Encodable, Sendable {
    var decision: Bool? = nil
    var approvalWait: Bool? = nil
    var error: Bool? = nil
    var reportComplete: Bool? = nil
    var todoCreated: Bool? = nil
    var reportBlocked: Bool? = nil
    private enum CodingKeys: String, CodingKey {
        case decision, approvalWait = "approval_wait", error, reportComplete = "report_complete"
        case todoCreated = "todo_created", reportBlocked = "report_blocked"
    }
}

struct PushDevice: Codable, Sendable, Identifiable {
    let id: String
    var label: String? = nil
    var platform: String? = nil
    var bundleId: String? = nil
    var environment: PushEnvironment? = nil
    var enabled: Bool? = nil
    var authorization: PushAuthorization? = nil
    var preferences: PushPreferences? = nil
    var state: PushDeviceState? = nil
    var revision: Int? = nil
    var registeredAt: String? = nil
    var lastSeenAt: String? = nil
    var expiresAt: String? = nil
    var lastAcceptedAt: String? = nil
    var lastFailure: String? = nil
}
struct PushDeviceList: Codable, Sendable { let devices: [PushDevice] }
struct PushProviderStatus: Codable, Sendable {
    let environment: PushEnvironment
    let bundleId: String
    let state: PushProviderState
    let lastError: String?
}
struct PushStatus: Codable, Sendable {
    let serverId: String
    let supported: Bool
    let providers: [PushProviderStatus]
}

/// Token requests are deliberately Encodable only; no response/persistence DTO retains tokens.
struct PushRegistrationRequest: Encodable, Sendable {
    let expectedRevision: Int?
    var platform: String = "ios"
    var bundleId: String = PushContract.bundleID
    let environment: PushEnvironment
    let deviceToken: String
    let authorization: PushAuthorization
    var label: String? = nil

    private enum CodingKeys: String, CodingKey {
        case expectedRevision, platform, bundleId, environment, deviceToken, authorization, label
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // A new registration requires explicit null, not an omitted precondition.
        try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encode(platform, forKey: .platform)
        try c.encode(bundleId, forKey: .bundleId)
        try c.encode(environment, forKey: .environment)
        try c.encode(deviceToken, forKey: .deviceToken)
        try c.encode(authorization, forKey: .authorization)
        try c.encodeIfPresent(label, forKey: .label)
    }
}
struct PushDevicePatchRequest: Encodable, Sendable {
    let expectedRevision: Int
    var enabled: Bool? = nil
    var preferences: PushPreferencesPatch? = nil
    var label: String? = nil
    var authorization: PushAuthorization? = nil
}
struct PushTestRequest: Encodable, Sendable { let requestId: String }
struct PushTestResult: Codable, Sendable { let notificationId: String; let state: PushDeliveryState }

struct PushReportGroupReference: Codable, Sendable {
    let id: String
    let projectId: String
    let memberId: String
    let openedAt: String
    let closesAt: String
    let lastMessageId: String
    let reportIds: [String]
}

enum PushTarget: Codable, Sendable, Equatable {
    case home
    case projectHome(projectId: String)
    case inbox(projectId: String, decisionId: String)
    case team(projectId: String, memberId: String)
    case chat(projectId: String, memberId: String?, messageId: String, groupId: String? = nil)
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case screen, projectId, decisionId, memberId, messageId, groupId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decodeIfPresent(String.self, forKey: .screen) {
        case "home":
            if c.contains(.projectId) { self = .projectHome(projectId: try c.decode(String.self, forKey: .projectId)) }
            else { self = .home }
        case "inbox": self = .inbox(projectId: try c.decode(String.self, forKey: .projectId), decisionId: try c.decode(String.self, forKey: .decisionId))
        case "team": self = .team(projectId: try c.decode(String.self, forKey: .projectId), memberId: try c.decode(String.self, forKey: .memberId))
        case "chat": self = .chat(projectId: try c.decode(String.self, forKey: .projectId), memberId: try c.decodeIfPresent(String.self, forKey: .memberId), messageId: try c.decode(String.self, forKey: .messageId), groupId: try c.decodeIfPresent(String.self, forKey: .groupId))
        case let screen: self = .unknown(screen ?? "unknown")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .home: try c.encode("home", forKey: .screen)
        case .projectHome(let projectId):
            try c.encode("home", forKey: .screen)
            try c.encode(projectId, forKey: .projectId)
        case .inbox(let projectId, let decisionId):
            try c.encode("inbox", forKey: .screen)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(decisionId, forKey: .decisionId)
        case .team(let projectId, let memberId):
            try c.encode("team", forKey: .screen)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(memberId, forKey: .memberId)
        case .chat(let projectId, let memberId, let messageId, let groupId):
            try c.encode("chat", forKey: .screen)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(memberId, forKey: .memberId)
            try c.encode(messageId, forKey: .messageId)
            try c.encodeIfPresent(groupId, forKey: .groupId)
        case .unknown(let screen): try c.encode(screen, forKey: .screen)
        }
    }
}
struct PushEventTarget: Codable, Sendable {
    let serverId: String
    let eventId: String
    let target: PushTarget
    let reportGroup: PushReportGroupReference?
}
struct PushNotificationMetadata: Codable, Sendable {
    let v: Int
    let serverId: String
    let eventId: String
    let kind: String // Includes test; an unknown kind never implies permission/approval.
    let target: PushTarget
}
