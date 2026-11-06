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

struct SyncRevisions: Codable, Sendable {
    var settings: Int? = nil
    var members: [String: MemberRevisions]? = nil
    var todos: [String: Int]? = nil
}
struct MemberRevisions: Codable, Sendable {
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

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol", cursor, requestedProjectId, projectStatus, bootstrap, state, revisions
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
        case "projects": projects = try c.decode([ProjectSummary].self, forKey: .projects)
        case "project": project = try c.decode(Project.self, forKey: .project)
        case "member": member = try c.decode(Member.self, forKey: .member)
        case "member_removed":
            projectId = try c.decode(String.self, forKey: .projectId)
            memberId = try c.decode(String.self, forKey: .memberId)
        case "decision": decision = try c.decode(Decision.self, forKey: .decision)
        case "todo": todo = try c.decode(Todo.self, forKey: .todo)
        case "work":
            projectId = try c.decode(String.self, forKey: .projectId)
            work = try c.decode([WorkItem].self, forKey: .work)
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
