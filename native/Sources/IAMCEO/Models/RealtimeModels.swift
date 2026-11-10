import Foundation

struct SyncCursor: Codable, Sendable, Equatable {
    let epoch: String
    let seq: Int

    init(epoch: String, seq: Int) throws {
        guard !epoch.isEmpty, (0...9_007_199_254_740_991).contains(seq) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Invalid sync cursor"))
        }
        self.epoch = epoch
        self.seq = seq
    }
    private enum CodingKeys: String, CodingKey { case epoch, seq }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(epoch: c.decode(String.self, forKey: .epoch), seq: c.decode(Int.self, forKey: .seq))
    }
}

enum SyncProjectStatus: String, SafeStringEnum {
    case none, ok, notFound = "not_found", archived, unknown
}

struct SyncRevisions: Codable, Sendable, Equatable {
    var settings: Int? = nil
    var members: [String: MemberRevisions]? = nil
    var todos: [String: Int]? = nil
}
struct MemberRevisions: Codable, Sendable, Equatable {
    let configRevision: Int
    let sessionGeneration: Int
}

struct SyncSnapshot: Codable, Sendable {
    let protocolVersion: Int
    let cursor: SyncCursor
    let requestedProjectId: String?
    let projectStatus: SyncProjectStatus
    let bootstrap: Bootstrap
    let state: ProjectState?
    let revisions: SyncRevisions?
    var apiOutage: APIOutage? = nil

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol", cursor, requestedProjectId, projectStatus, bootstrap, state, revisions, apiOutage
    }
}
extension SyncSnapshot {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try c.decode(Int.self, forKey: .protocolVersion)
        cursor = try c.decode(SyncCursor.self, forKey: .cursor)
        requestedProjectId = try c.decodeIfPresent(String.self, forKey: .requestedProjectId)
        projectStatus = try c.decodeIfPresent(SyncProjectStatus.self, forKey: .projectStatus) ?? .unknown
        bootstrap = try c.decode(Bootstrap.self, forKey: .bootstrap)
        state = try c.decodeIfPresent(ProjectState.self, forKey: .state)
        revisions = try c.decodeIfPresent(SyncRevisions.self, forKey: .revisions)
        apiOutage = c.lenient(APIOutage.self, forKey: .apiOutage)
        guard protocolVersion == 2 else {
            throw DecodingError.dataCorruptedError(forKey: .protocolVersion, in: c, debugDescription: "Unsupported sync protocol")
        }
        switch projectStatus {
        case .ok:
            guard let requestedProjectId, state?.project.id == requestedProjectId else {
                throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "Snapshot project mismatch")
            }
        case .none, .notFound, .archived:
            guard state == nil, (projectStatus == .none) == (requestedProjectId == nil) else {
                throw DecodingError.dataCorruptedError(forKey: .projectStatus, in: c, debugDescription: "Invalid project status")
            }
        case .unknown: break // Display unsupported state; never treat it as an active project.
        }
    }
}

struct ServerCapabilities: Codable, Sendable {
    var contractVersion: Int? = nil
    var capabilities: CapabilityFlags? = nil
}
struct CapabilityFlags: Codable, Sendable {
    var paging: Bool? = nil
    var archive: Bool? = nil
    var delivery: Bool? = nil
    var realtime: Bool? = nil
    var push: Bool? = nil
    var operations: Bool? = nil
}

/// Both legacy invalidations and v2 changes retain the original domain payload.
/// Unknown type strings retain their cursor so the coordinator can request a full sync.
struct RealtimeEvent: Decodable, Sendable {
    let type: String
    let protocolVersion: Int?
    let seq: Int?
    let cursor: SyncCursor?
    let heartbeatMs: Int?
    let staleAfterMs: Int?
    var projects: [ProjectSummary]? = nil
    var project: Project? = nil
    var member: Member? = nil
    var projectId: String? = nil
    var memberId: String? = nil
    var decision: Decision? = nil
    var todo: Todo? = nil
    var work: [WorkItem]? = nil
    var message: Message? = nil
    var file: FileDoc? = nil
    var activity: Activity? = nil
    var settings: Settings? = nil
    var herdr: HerdrInfo? = nil
    /// 봉투(type·순번)는 멀쩡한데 본문을 읽지 못한 프레임. 받는 쪽은 '무엇인지 모르는 변경'으로 보고 전체를 다시 읽는다.
    var payloadUnreadable = false

    private static let payloadTypes: Set<String> = ["projects", "project", "member", "member_removed", "decision", "todo", "work", "message", "file", "activity", "settings", "herdr"]
    /// 본문 해석에 실패한 프레임에서 봉투만 살린다. hello·ping처럼 본문이 없는 프레임이나 봉투가 깨진 프레임은 nil(잘못된 프레임)이다.
    static func unreadable(from data: Data) -> RealtimeEvent? {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data), payloadTypes.contains(envelope.type) else { return nil }
        return RealtimeEvent(type: envelope.type, cursor: envelope.cursor)
    }
    private init(type: String, cursor: SyncCursor?) {
        self.type = type; self.cursor = cursor
        protocolVersion = nil; seq = cursor?.seq; heartbeatMs = nil; staleAfterMs = nil
        payloadUnreadable = true
    }
    private struct Envelope: Decodable {
        let type: String
        let cursor: SyncCursor?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            // 변경 프레임에는 protocol이 없다. 순번 규칙은 정식 해석과 같다.
            guard try c.decodeIfPresent(Int.self, forKey: .protocolVersion) == nil else {
                throw DecodingError.dataCorruptedError(forKey: .protocolVersion, in: c, debugDescription: "Unexpected protocol")
            }
            if c.contains(.epoch) {
                cursor = try SyncCursor(epoch: c.decode(String.self, forKey: .epoch), seq: c.decode(Int.self, forKey: .seq))
            } else {
                cursor = nil
                guard try c.decodeIfPresent(Int.self, forKey: .seq) == nil else {
                    throw DecodingError.dataCorruptedError(forKey: .seq, in: c, debugDescription: "Invalid legacy sequence")
                }
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, protocolVersion = "protocol", epoch, seq, heartbeatMs, staleAfterMs
        case projects, project, member, projectId, memberId, decision, todo, work, message, file, activity, settings, herdr
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        protocolVersion = try c.decodeIfPresent(Int.self, forKey: .protocolVersion)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        if c.contains(.epoch) || protocolVersion == 2 {
            cursor = try SyncCursor(epoch: c.decode(String.self, forKey: .epoch), seq: c.decode(Int.self, forKey: .seq))
        } else {
            cursor = nil
            if let seq, (!(0...9_007_199_254_740_991).contains(seq) || type != "hello") {
                throw DecodingError.dataCorruptedError(forKey: .seq, in: c, debugDescription: "Invalid legacy sequence")
            }
        }
        heartbeatMs = try c.decodeIfPresent(Int.self, forKey: .heartbeatMs)
        staleAfterMs = try c.decodeIfPresent(Int.self, forKey: .staleAfterMs)
        switch type {
        case "hello":
            guard seq != nil else {
                throw DecodingError.keyNotFound(CodingKeys.seq, .init(codingPath: decoder.codingPath, debugDescription: "Hello requires sequence"))
            }
            guard (protocolVersion == nil && cursor == nil) || protocolVersion == 2 else {
                throw DecodingError.dataCorruptedError(forKey: .protocolVersion, in: c, debugDescription: "Unsupported realtime protocol")
            }
            if protocolVersion == 2 && (heartbeatMs != 15_000 || staleAfterMs != 45_000) {
                throw DecodingError.dataCorruptedError(forKey: .heartbeatMs, in: c, debugDescription: "Invalid heartbeat contract")
            }
        case "ping": break
        case "projects": projects = try c.requiredLossyArray(ProjectSummary.self, forKey: .projects)
        case "project": project = try c.decode(Project.self, forKey: .project)
        case "member": member = try c.decode(Member.self, forKey: .member)
        case "member_removed":
            projectId = try c.decode(String.self, forKey: .projectId)
            memberId = try c.decode(String.self, forKey: .memberId)
        case "decision": decision = try c.decode(Decision.self, forKey: .decision)
        case "todo": todo = try c.decode(Todo.self, forKey: .todo)
        case "work":
            projectId = try c.decode(String.self, forKey: .projectId)
            work = try c.requiredLossyArray(WorkItem.self, forKey: .work)
        case "message": message = try c.decode(Message.self, forKey: .message)
        case "file": file = try c.decode(FileDoc.self, forKey: .file)
        case "activity":
            projectId = try c.decode(String.self, forKey: .projectId)
            activity = try c.decode(Activity.self, forKey: .activity)
        case "settings": settings = try c.decode(Settings.self, forKey: .settings)
        case "herdr": herdr = try c.decode(HerdrInfo.self, forKey: .herdr)
        default: break
        }
    }
}
