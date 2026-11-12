import Foundation
import OSLog

// String-valued server enums deliberately preserve newly introduced daemon values.

struct ProjectConnection: Codable, Sendable, Equatable {
    var ok: Bool = false
    var reason: String? = nil
    var detail: String? = nil

    /// What the owner reads. A runner-down detail ends with the raw transport error in parentheses
    /// ("… (hello: connect ENOENT /…/core.sock. Start herdr-core with …)"); that belongs in 실행 환경 보기, not in a banner.
    var ownerDetail: String? {
        guard let detail, !detail.isEmpty else { return nil }
        guard reason == "backend_down", let open = detail.range(of: " (", options: .backwards), detail.hasSuffix(")") else { return detail }
        let head = detail[..<open.lowerBound].trimmingCharacters(in: .whitespaces)
        return head.isEmpty ? detail : head + " · 원인은 실행 환경 보기에서 확인할 수 있습니다"
    }
}
extension ProjectConnection {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: ModelKey("ok")) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: ModelKey("reason"))
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail"))
    }
}

struct Project: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var name: String = ""
    var isHq: Bool = false
    var cwd: String = ""
    var runnerEnabled: Bool = false
    var now: String = ""
    var nowAt: String? = nil
    var archived: Bool = false
    var createdAt: String = ""
    var updatedAt: String = ""
    var connection: ProjectConnection = ProjectConnection()
    var tidiedAt: String? = nil
}
extension Project {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        name = try c.decodeIfPresent(String.self, forKey: ModelKey("name")) ?? ""
        isHq = try c.decodeIfPresent(Bool.self, forKey: ModelKey("isHq")) ?? false
        cwd = try c.decodeIfPresent(String.self, forKey: ModelKey("cwd")) ?? ""
        runnerEnabled = try c.decodeIfPresent(Bool.self, forKey: ModelKey("runnerEnabled")) ?? false
        now = try c.decodeIfPresent(String.self, forKey: ModelKey("now")) ?? ""
        nowAt = try c.decodeIfPresent(String.self, forKey: ModelKey("nowAt"))
        archived = try c.decodeIfPresent(Bool.self, forKey: ModelKey("archived")) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("updatedAt")) ?? ""
        connection = try c.decodeIfPresent(ProjectConnection.self, forKey: ModelKey("connection")) ?? ProjectConnection()
        tidiedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("tidiedAt"))
    }
}

struct ProjectSummary: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var name: String = ""
    var isHq: Bool = false
    var cwd: String = ""
    var now: String = ""
    var runnerEnabled: Bool = false
    var connection: ProjectConnection = ProjectConnection()
    var decisionCount: Int = 0
    var todoCount: Int = 0
    var needsCount: Int? = nil
    var needsDanger: Bool? = nil
    var inboxCount: Int = 0
    var workingCount: Int = 0
    var blockedCount: Int = 0
    var errorCount: Int = 0
    var memberCount: Int = 0
}
extension ProjectSummary {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        name = try c.decodeIfPresent(String.self, forKey: ModelKey("name")) ?? ""
        isHq = try c.decodeIfPresent(Bool.self, forKey: ModelKey("isHq")) ?? false
        cwd = try c.decodeIfPresent(String.self, forKey: ModelKey("cwd")) ?? ""
        now = try c.decodeIfPresent(String.self, forKey: ModelKey("now")) ?? ""
        runnerEnabled = try c.decodeIfPresent(Bool.self, forKey: ModelKey("runnerEnabled")) ?? false
        connection = try c.decodeIfPresent(ProjectConnection.self, forKey: ModelKey("connection")) ?? ProjectConnection()
        decisionCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("decisionCount")) ?? 0
        todoCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("todoCount")) ?? 0
        needsCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("needsCount"))
        needsDanger = try c.decodeIfPresent(Bool.self, forKey: ModelKey("needsDanger"))
        inboxCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("inboxCount")) ?? 0
        workingCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("workingCount")) ?? 0
        blockedCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("blockedCount")) ?? 0
        errorCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("errorCount")) ?? 0
        memberCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("memberCount")) ?? 0
    }
}

struct Member: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var projectId: String = ""
    var handle: String = ""
    var name: String = ""
    var role: String = ""
    var kind: String = "worker"
    var origin: String = "runner"
    var wasAdopted: Bool = false
    var cli: String = "claude"
    var backend: String? = nil
    var modelOverride: String? = nil
    var effortOverride: String? = nil
    var appliedModel: String? = nil
    var appliedEffort: String? = nil
    var status: String = "offline"
    var now: String = ""
    var next: String = ""
    var cwd: String = ""
    var sessionId: String? = nil
    var paneId: String? = nil
    var contextPct: Double? = nil
    var subagents: Int = 0
    var parallel: Bool = false
    var queuedCount: Int = 0
    var lastError: String? = nil
    var updatedAt: String = ""
    var createdAt: String = ""
    var contextWindow: Int? = nil
    var contextWindowSource: String? = nil
    var contextState: CoreContextState? = nil
    var blockedReason: String? = nil
    var nowAt: String? = nil
    var manualActivityAt: String? = nil
    var statusObservation: StatusObservation? = nil
    var subagentState: SubagentState? = nil
    var executionState: MemberExecutionState? = nil
    var lifecycleState: MemberLifecycleState? = nil
    /// When the member's CLI last did work (its latest turn or tool call); nil from older servers or if it never ran.
    var lastActiveAt: String? = nil
    /// Why the server thinks a blocked member is stuck ("trust_dialog_unrecognized", "start_not_ready"); nil from older
    /// servers. An unknown code is shown like no code at all.
    var blockedCode: String? = nil
}
extension Member {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        handle = try c.decodeIfPresent(String.self, forKey: ModelKey("handle")) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: ModelKey("name")) ?? ""
        role = try c.decodeIfPresent(String.self, forKey: ModelKey("role")) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: ModelKey("kind")) ?? "worker"
        origin = try c.decodeIfPresent(String.self, forKey: ModelKey("origin")) ?? "runner"
        wasAdopted = try c.decodeIfPresent(Bool.self, forKey: ModelKey("wasAdopted")) ?? false
        cli = try c.decodeIfPresent(String.self, forKey: ModelKey("cli")) ?? "claude"
        backend = try c.decodeIfPresent(String.self, forKey: ModelKey("backend"))
        modelOverride = try c.decodeIfPresent(String.self, forKey: ModelKey("modelOverride"))
        effortOverride = try c.decodeIfPresent(String.self, forKey: ModelKey("effortOverride"))
        appliedModel = try c.decodeIfPresent(String.self, forKey: ModelKey("appliedModel"))
        appliedEffort = try c.decodeIfPresent(String.self, forKey: ModelKey("appliedEffort"))
        status = try c.decodeIfPresent(String.self, forKey: ModelKey("status")) ?? "offline"
        now = try c.decodeIfPresent(String.self, forKey: ModelKey("now")) ?? ""
        next = try c.decodeIfPresent(String.self, forKey: ModelKey("next")) ?? ""
        cwd = try c.decodeIfPresent(String.self, forKey: ModelKey("cwd")) ?? ""
        sessionId = try c.decodeIfPresent(String.self, forKey: ModelKey("sessionId"))
        paneId = try c.decodeIfPresent(String.self, forKey: ModelKey("paneId"))
        contextPct = try c.decodeIfPresent(Double.self, forKey: ModelKey("contextPct"))
        subagents = try c.decodeIfPresent(Int.self, forKey: ModelKey("subagents")) ?? 0
        parallel = try c.decodeIfPresent(Bool.self, forKey: ModelKey("parallel")) ?? false
        queuedCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("queuedCount")) ?? 0
        lastError = try c.decodeIfPresent(String.self, forKey: ModelKey("lastError"))
        updatedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("updatedAt")) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        contextWindow = try c.decodeIfPresent(Int.self, forKey: ModelKey("contextWindow"))
        contextWindowSource = try c.decodeIfPresent(String.self, forKey: ModelKey("contextWindowSource"))
        contextState = c.lenient(CoreContextState.self, forKey: ModelKey("contextState"))
        blockedReason = try c.decodeIfPresent(String.self, forKey: ModelKey("blockedReason"))
        nowAt = try c.decodeIfPresent(String.self, forKey: ModelKey("nowAt"))
        manualActivityAt = try c.decodeIfPresent(String.self, forKey: ModelKey("manualActivityAt"))
        statusObservation = c.lenient(StatusObservation.self, forKey: ModelKey("statusObservation"))
        subagentState = c.lenient(SubagentState.self, forKey: ModelKey("subagentState"))
        executionState = c.lenient(MemberExecutionState.self, forKey: ModelKey("executionState"))
        lifecycleState = c.lenient(MemberLifecycleState.self, forKey: ModelKey("lifecycleState"))
        lastActiveAt = try c.decodeIfPresent(String.self, forKey: ModelKey("lastActiveAt"))
        blockedCode = c.lenient(String.self, forKey: ModelKey("blockedCode"))
    }
}

struct DecisionOption: Codable, Sendable, Equatable {
    var k: String = ""
    var label: String = ""
    var desc: String? = nil
}
extension DecisionOption {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        k = try c.decodeIfPresent(String.self, forKey: ModelKey("k")) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: ModelKey("label")) ?? ""
        desc = try c.decodeIfPresent(String.self, forKey: ModelKey("desc"))
    }
}

struct APIOutage: Codable, Sendable, Equatable {
    var since: String
    var affectedMemberIds: [String]
    var lastProbeAt: String?
}

struct UsageLimit: Codable, Sendable, Equatable {
    var cli: String
    var resetsAt: String? = nil
    var memberIds: [String] = []
    var stillLimited: Bool = false
}
extension UsageLimit {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        cli = try c.decodeIfPresent(String.self, forKey: ModelKey("cli")) ?? ""
        resetsAt = try c.decodeIfPresent(String.self, forKey: ModelKey("resetsAt"))
        memberIds = try c.decodeIfPresent([String].self, forKey: ModelKey("memberIds")) ?? []
        stillLimited = try c.decodeIfPresent(Bool.self, forKey: ModelKey("stillLimited")) ?? false
    }
}

struct Decision: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var projectId: String = ""
    var memberId: String? = nil
    var who: String = ""
    var kind: String? = nil
    var usageLimit: UsageLimit? = nil
    var title: String = ""
    var detail: String = ""
    var options: [DecisionOption] = []
    var rec: String? = nil
    var group: String? = nil
    var fileId: String? = nil
    var images: [Attachment] = []
    var status: String = "open"
    var choice: String? = nil
    var note: String? = nil
    var batch: Bool = false
    var createdAt: String = ""
    var updatedAt: String = ""
    var answeredAt: String? = nil
    var deliveredAt: String? = nil
    var lastChoice: String? = nil
    var lastNote: String? = nil
    var reopenNote: String? = nil
    var closeKind: String? = nil
    var closeReason: String? = nil
    var closeQuote: String? = nil
    var closedBy: String? = nil
    var closedAt: String? = nil
}
extension Decision {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        memberId = try c.decodeIfPresent(String.self, forKey: ModelKey("memberId"))
        who = try c.decodeIfPresent(String.self, forKey: ModelKey("who")) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: ModelKey("kind"))
        usageLimit = c.lenient(UsageLimit.self, forKey: ModelKey("usageLimit"))
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail")) ?? ""
        options = try c.lossyArray(DecisionOption.self, forKey: ModelKey("options")) ?? []
        rec = try c.decodeIfPresent(String.self, forKey: ModelKey("rec"))
        group = try c.decodeIfPresent(String.self, forKey: ModelKey("group"))
        fileId = try c.decodeIfPresent(String.self, forKey: ModelKey("fileId"))
        images = try c.lossyArray(Attachment.self, forKey: ModelKey("images")) ?? []
        status = try c.decodeIfPresent(String.self, forKey: ModelKey("status")) ?? "open"
        choice = try c.decodeIfPresent(String.self, forKey: ModelKey("choice"))
        note = try c.decodeIfPresent(String.self, forKey: ModelKey("note"))
        batch = try c.decodeIfPresent(Bool.self, forKey: ModelKey("batch")) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("updatedAt")) ?? ""
        answeredAt = try c.decodeIfPresent(String.self, forKey: ModelKey("answeredAt"))
        deliveredAt = try c.decodeIfPresent(String.self, forKey: ModelKey("deliveredAt"))
        lastChoice = try c.decodeIfPresent(String.self, forKey: ModelKey("lastChoice"))
        lastNote = try c.decodeIfPresent(String.self, forKey: ModelKey("lastNote"))
        reopenNote = try c.decodeIfPresent(String.self, forKey: ModelKey("reopenNote"))
        closeKind = try c.decodeIfPresent(String.self, forKey: ModelKey("closeKind"))
        closeReason = try c.decodeIfPresent(String.self, forKey: ModelKey("closeReason"))
        closeQuote = try c.decodeIfPresent(String.self, forKey: ModelKey("closeQuote"))
        closedBy = try c.decodeIfPresent(String.self, forKey: ModelKey("closedBy"))
        closedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("closedAt"))
    }
}

struct Todo: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var projectId: String = ""
    var memberId: String? = nil
    var who: String = ""
    var title: String = ""
    var detail: String = ""
    var completionNote: String? = nil
    var completionFileIds: [String] = []
    var done: Bool = false
    var doneAt: String? = nil
    var createdAt: String = ""
    var outcome: String? = nil
    var closeReason: String? = nil
    var closedBy: String? = nil
}
extension Todo {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        memberId = try c.decodeIfPresent(String.self, forKey: ModelKey("memberId"))
        who = try c.decodeIfPresent(String.self, forKey: ModelKey("who")) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail")) ?? ""
        completionNote = try c.decodeIfPresent(String.self, forKey: ModelKey("completionNote"))
        completionFileIds = try c.decodeIfPresent([String].self, forKey: ModelKey("completionFileIds")) ?? []
        done = try c.decodeIfPresent(Bool.self, forKey: ModelKey("done")) ?? false
        doneAt = try c.decodeIfPresent(String.self, forKey: ModelKey("doneAt"))
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        outcome = try c.decodeIfPresent(String.self, forKey: ModelKey("outcome"))
        closeReason = try c.decodeIfPresent(String.self, forKey: ModelKey("closeReason"))
        closedBy = try c.decodeIfPresent(String.self, forKey: ModelKey("closedBy"))
    }
}

struct WorkItem: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var projectId: String = ""
    var sec: String = ""
    var title: String = ""
    var detail: String = ""
    var who: String = ""
    var order: Int = 0
    var doneAt: String? = nil
    var createdAt: String = ""
    var updatedAt: String = ""
}
extension WorkItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        sec = try c.decodeIfPresent(String.self, forKey: ModelKey("sec")) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail")) ?? ""
        who = try c.decodeIfPresent(String.self, forKey: ModelKey("who")) ?? ""
        order = try c.decodeIfPresent(Int.self, forKey: ModelKey("order")) ?? 0
        doneAt = try c.decodeIfPresent(String.self, forKey: ModelKey("doneAt"))
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: ModelKey("updatedAt")) ?? ""
    }
}

struct Attachment: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var name: String = ""
    var mime: String = ""
    var size: Int = 0
    var url: String = ""
    var path: String = ""
    var isImage: Bool = false
}
extension Attachment {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        name = try c.decodeIfPresent(String.self, forKey: ModelKey("name")) ?? ""
        mime = try c.decodeIfPresent(String.self, forKey: ModelKey("mime")) ?? ""
        size = try c.decodeIfPresent(Int.self, forKey: ModelKey("size")) ?? 0
        url = try c.decodeIfPresent(String.self, forKey: ModelKey("url")) ?? ""
        path = try c.decodeIfPresent(String.self, forKey: ModelKey("path")) ?? ""
        isImage = try c.decodeIfPresent(Bool.self, forKey: ModelKey("isImage")) ?? false
    }
}

struct Message: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var projectId: String = ""
    var at: String = ""
    var mine: Bool = false
    var memberId: String? = nil
    var who: String = ""
    var kind: String = ""
    var title: String = ""
    var body: String = ""
    var targetMemberId: String? = nil
    var targetName: String? = nil
    var decisionId: String? = nil
    var fileId: String? = nil
    var fileIds: [String] = []
    var supersedes: String? = nil
    var supersededBy: String? = nil
    var contextFileId: String? = nil
    var deliveryInfo: [MessageDeliveryInfo]? = nil
    var attachments: [Attachment] = []
    var delivery: String? = nil
    var deliveryNote: String? = nil
    /// deliveryNote 가 정해진 보류 문장일 때 서버가 함께 주는 코드(예: held_delivery_unknown). 옛 서버는 싣지 않는다.
    var deliveryCode: String? = nil
    var deliveryRevision: Int? = nil
}
extension Message {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: ModelKey("at")) ?? ""
        mine = try c.decodeIfPresent(Bool.self, forKey: ModelKey("mine")) ?? false
        memberId = try c.decodeIfPresent(String.self, forKey: ModelKey("memberId"))
        who = try c.decodeIfPresent(String.self, forKey: ModelKey("who")) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: ModelKey("kind")) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: ModelKey("body")) ?? ""
        targetMemberId = try c.decodeIfPresent(String.self, forKey: ModelKey("targetMemberId"))
        targetName = try c.decodeIfPresent(String.self, forKey: ModelKey("targetName"))
        decisionId = try c.decodeIfPresent(String.self, forKey: ModelKey("decisionId"))
        fileId = try c.decodeIfPresent(String.self, forKey: ModelKey("fileId"))
        fileIds = try c.decodeIfPresent([String].self, forKey: ModelKey("fileIds")) ?? fileId.map { [$0] } ?? []
        supersedes = try c.decodeIfPresent(String.self, forKey: ModelKey("supersedes"))
        supersededBy = try c.decodeIfPresent(String.self, forKey: ModelKey("supersededBy"))
        contextFileId = try c.decodeIfPresent(String.self, forKey: ModelKey("contextFileId"))
        deliveryInfo = c.lenientArray(MessageDeliveryInfo.self, forKey: ModelKey("deliveryInfo"))
        attachments = try c.lossyArray(Attachment.self, forKey: ModelKey("attachments")) ?? []
        delivery = try c.decodeIfPresent(String.self, forKey: ModelKey("delivery"))
        if try c.decodeIfPresent(String.self, forKey: ModelKey("deliveryDisposition")) == "dismissed" { delivery = "dismissed" }
        deliveryNote = try c.decodeIfPresent(String.self, forKey: ModelKey("deliveryNote"))
        deliveryCode = try? c.decodeIfPresent(String.self, forKey: ModelKey("deliveryCode"))
        deliveryRevision = try c.decodeIfPresent(Int.self, forKey: ModelKey("deliveryRevision"))
    }
}

struct FileDoc: Codable, Sendable, Identifiable, Equatable {
    var id: String = ""
    var kind: String = ""
    var projectId: String = ""
    var title: String = ""
    var who: String = ""
    var memberId: String? = nil
    var summary: String = ""
    var body: String = ""
    var path: String? = nil
    var attachments: [Attachment] = []
    var createdAt: String = ""
    var order: Int = 0
    var reused: Bool? = nil
}
extension FileDoc {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(String.self, forKey: ModelKey("id"))
        kind = try c.decodeIfPresent(String.self, forKey: ModelKey("kind")) ?? ""
        projectId = try c.decodeIfPresent(String.self, forKey: ModelKey("projectId")) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        who = try c.decodeIfPresent(String.self, forKey: ModelKey("who")) ?? ""
        memberId = try c.decodeIfPresent(String.self, forKey: ModelKey("memberId"))
        summary = try c.decodeIfPresent(String.self, forKey: ModelKey("summary")) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: ModelKey("body")) ?? ""
        path = try c.decodeIfPresent(String.self, forKey: ModelKey("path"))
        attachments = try c.lossyArray(Attachment.self, forKey: ModelKey("attachments")) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        reused = try c.decodeIfPresent(Bool.self, forKey: ModelKey("reused"))
        order = try c.decodeIfPresent(Int.self, forKey: ModelKey("order")) ?? 0
    }
}

struct Activity: Codable, Sendable, Identifiable {
    var id: Int = 0
    var memberId: String = ""
    var at: String = ""
    var kind: String = ""
    var text: String = ""
}
extension Activity {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        id = try c.decode(Int.self, forKey: ModelKey("id"))
        memberId = try c.decodeIfPresent(String.self, forKey: ModelKey("memberId")) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: ModelKey("at")) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: ModelKey("kind")) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: ModelKey("text")) ?? ""
    }
}

struct RankConfig: Codable, Sendable, Equatable {
    var model: String? = nil
    var effort: String? = nil
}
extension RankConfig {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        model = try c.decodeIfPresent(String.self, forKey: ModelKey("model"))
        effort = try c.decodeIfPresent(String.self, forKey: ModelKey("effort"))
    }
}

struct Settings: Codable, Sendable, Equatable {
    var backend: String? = nil
    var permissionMode: String = "default"
    var ranks: [String: RankConfig] = [:]
    var codexRanks: [String: RankConfig] = [:]
    var maxConcurrentTurns: Int = 4
    var compactAtPct: Int = 70
    var maxAwakeWorkers: Int = 8
    var notifyMac: Bool = false
    var macScriptNotifications: Bool = true
    var boardTidyHours: Double = 6
    var contextWindowDefault: Int? = nil
    var contextWindows: [String: Int]? = nil
    /// false only on a server that has not been told how sessions may run commands yet (a brand-new install).
    /// nil from older servers, which is read as "already chosen": the first-run choice is never shown for them.
    var permissionAcknowledged: Bool? = nil
    /// Language the lead and staff write to the owner in ("ko" | "en"). nil from older servers: the row is hidden there.
    var reportLanguage: String? = nil
}
extension Settings {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        backend = try c.decodeIfPresent(String.self, forKey: ModelKey("backend"))
        permissionMode = try c.decodeIfPresent(String.self, forKey: ModelKey("permissionMode")) ?? "default"
        ranks = try c.decodeIfPresent([String: RankConfig].self, forKey: ModelKey("ranks")) ?? [:]
        codexRanks = try c.decodeIfPresent([String: RankConfig].self, forKey: ModelKey("codexRanks")) ?? [:]
        maxConcurrentTurns = try c.decodeIfPresent(Int.self, forKey: ModelKey("maxConcurrentTurns")) ?? 4
        compactAtPct = try c.decodeIfPresent(Int.self, forKey: ModelKey("compactAtPct")) ?? 70
        maxAwakeWorkers = try c.decodeIfPresent(Int.self, forKey: ModelKey("maxAwakeWorkers")) ?? 8
        macScriptNotifications = try c.decodeIfPresent(Bool.self, forKey: ModelKey("macScriptNotifications")) ?? true
        notifyMac = try c.decodeIfPresent(Bool.self, forKey: ModelKey("notifyMac")) ?? false
        boardTidyHours = try c.decodeIfPresent(Double.self, forKey: ModelKey("boardTidyHours")) ?? 6
        contextWindowDefault = try c.decodeIfPresent(Int.self, forKey: ModelKey("contextWindowDefault"))
        contextWindows = try c.decodeIfPresent([String: Int].self, forKey: ModelKey("contextWindows"))
        permissionAcknowledged = c.lenient(Bool.self, forKey: ModelKey("permissionAcknowledged"))
        reportLanguage = c.lenient(String.self, forKey: ModelKey("reportLanguage"))
    }
}

struct HerdrInfo: Codable, Sendable, Equatable {
    var installed: Bool = false
    var running: Bool = false
    var compatible: Bool = false
    var version: String? = nil
    var warning: String? = nil
}
extension HerdrInfo {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        installed = try c.decodeIfPresent(Bool.self, forKey: ModelKey("installed")) ?? false
        running = try c.decodeIfPresent(Bool.self, forKey: ModelKey("running")) ?? false
        compatible = try c.decodeIfPresent(Bool.self, forKey: ModelKey("compatible")) ?? false
        version = try c.decodeIfPresent(String.self, forKey: ModelKey("version"))
        warning = try c.decodeIfPresent(String.self, forKey: ModelKey("warning"))
    }
}

struct Bootstrap: Codable, Sendable, Equatable {
    var apiOutage: APIOutage? = nil
    var runtime: RuntimeDiagnostics? = nil
    var version: String = ""
    var settings: Settings = Settings()
    var projects: [ProjectSummary] = []
    var herdr: HerdrInfo = HerdrInfo()
    var home: String = ""
    var urls: [String] = []
    var cli: String = "iamceo"
    var rankOverrides: [String: Int] = [:]
    /// Health of the execution engine (herdr-core); nil from older servers.
    var engine: EngineState? = nil
    /// Tailscale on the server's Mac; nil from older servers and from installs that never opened a Tailscale address.
    var tailnet: TailnetState? = nil
    /// D5: 서버 버전과 API 단계. 버전 머리글을 받은 서버만 싣는다(옛 서버는 nil).
    var server: ServerVersionInfo? = nil
    /// D5: 앱과 서버가 실제로 맞지 않을 때만 실린다.
    var compat: CompatState? = nil
}
extension Bootstrap {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        apiOutage = c.lenient(APIOutage.self, forKey: ModelKey("apiOutage"))
        runtime = c.lenient(RuntimeDiagnostics.self, forKey: ModelKey("runtime"))
        version = try c.decodeIfPresent(String.self, forKey: ModelKey("version")) ?? ""
        settings = try c.decodeIfPresent(Settings.self, forKey: ModelKey("settings")) ?? Settings()
        // 키 자체는 필수로 둔다: 목록이 없는 응답을 빈 회사로 읽지 않는다.
        projects = try c.requiredLossyArray(ProjectSummary.self, forKey: ModelKey("projects"))
        herdr = try c.decodeIfPresent(HerdrInfo.self, forKey: ModelKey("herdr")) ?? HerdrInfo()
        home = try c.decodeIfPresent(String.self, forKey: ModelKey("home")) ?? ""
        urls = try c.decodeIfPresent([String].self, forKey: ModelKey("urls")) ?? []
        cli = try c.decodeIfPresent(String.self, forKey: ModelKey("cli")) ?? "iamceo"
        rankOverrides = try c.decodeIfPresent([String: Int].self, forKey: ModelKey("rankOverrides")) ?? [:]
        engine = c.lenient(EngineState.self, forKey: ModelKey("engine"))
        tailnet = c.lenient(TailnetState.self, forKey: ModelKey("tailnet"))
        server = c.lenient(ServerVersionInfo.self, forKey: ModelKey("server"))
        compat = c.lenient(CompatState.self, forKey: ModelKey("compat"))
    }
}

/// `state` stays a plain string: a value this app does not know ("ok" included) shows nothing.
struct EngineState: Codable, Sendable, Equatable {
    var state: String = "ok"
    var version: String? = nil
    var expectedVersion: String? = nil
}
extension EngineState {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        state = try c.decode(String.self, forKey: ModelKey("state"))
        version = c.lenient(String.self, forKey: ModelKey("version"))
        expectedVersion = c.lenient(String.self, forKey: ModelKey("expectedVersion"))
    }
}

/// `state` stays a plain string: only "off" (Tailscale is off on the server's Mac, so the iPhone cannot reach it)
/// shows anything; "ok" and values this app does not know are silent.
struct TailnetState: Codable, Sendable, Equatable {
    var state: String = "ok"
    var lastAddress: String? = nil
    /// When the address went missing (ISO). It also tells one off period from the next.
    var since: String? = nil
    /// The server already posted the Mac notification for this off period, so the app must not post its own.
    var macNotified: Bool? = nil
}
extension TailnetState {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        state = try c.decode(String.self, forKey: ModelKey("state"))
        lastAddress = c.lenient(String.self, forKey: ModelKey("lastAddress"))
        since = c.lenient(String.self, forKey: ModelKey("since"))
        macNotified = c.lenient(Bool.self, forKey: ModelKey("macNotified"))
    }
}

struct ProjectState: Codable, Sendable, Equatable {
    var project: Project = Project()
    var members: [Member] = []
    var decisions: [Decision] = []
    var doneDecisionCount: Int = 0
    var todos: [Todo] = []
    var work: [WorkItem] = []
    var messages: [Message] = []
    var files: [FileDoc] = []
    var deliveryNotices: DeliveryNotices? = nil
}
extension ProjectState {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        project = try c.decode(Project.self, forKey: ModelKey("project"))
        members = try c.lossyArray(Member.self, forKey: ModelKey("members")) ?? []
        decisions = try c.lossyArray(Decision.self, forKey: ModelKey("decisions")) ?? []
        doneDecisionCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("doneDecisionCount")) ?? 0
        todos = try c.lossyArray(Todo.self, forKey: ModelKey("todos")) ?? []
        work = try c.lossyArray(WorkItem.self, forKey: ModelKey("work")) ?? []
        messages = try c.lossyArray(Message.self, forKey: ModelKey("messages")) ?? []
        files = try c.lossyArray(FileDoc.self, forKey: ModelKey("files")) ?? []
        deliveryNotices = c.lenient(DeliveryNotices.self, forKey: ModelKey("deliveryNotices"))
    }
}

struct CoreRuntime: Codable, Sendable, Equatable {
    var installed: Bool = false
    var available: Bool = false
    var version: String? = nil
    var detail: String? = nil
}
extension CoreRuntime {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        installed = try c.decodeIfPresent(Bool.self, forKey: ModelKey("installed")) ?? false
        available = try c.decodeIfPresent(Bool.self, forKey: ModelKey("available")) ?? false
        version = try c.decodeIfPresent(String.self, forKey: ModelKey("version"))
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail"))
    }
}

struct ProviderRuntime: Codable, Sendable, Equatable {
    var installed: Bool = false
}
extension ProviderRuntime {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        installed = try c.decodeIfPresent(Bool.self, forKey: ModelKey("installed")) ?? false
    }
}

struct RuntimeDiagnostics: Codable, Sendable, Equatable {
    var backend: String = "core"
    var core: CoreRuntime = CoreRuntime()
    var providers: [String: ProviderRuntime] = [:]
}
extension RuntimeDiagnostics {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        backend = try c.decodeIfPresent(String.self, forKey: ModelKey("backend")) ?? "core"
        core = try c.decodeIfPresent(CoreRuntime.self, forKey: ModelKey("core")) ?? CoreRuntime()
        providers = try c.decodeIfPresent([String: ProviderRuntime].self, forKey: ModelKey("providers")) ?? [:]
    }
}

private struct ModelKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// 읽지 못해 건너뛴 항목의 기록. 형과 위치만 남기고 값은 남기지 않는다.
enum ContractLog {
    private static let logger = Logger(subsystem: "com.iamceo.native", category: "Contract")
    static func skipped(_ type: Any.Type, _ error: any Error, fallback: [any CodingKey]) {
        let (reason, path) = describe(error, fallback: fallback)
        let name = String(describing: type)
        logger.error("skipped \(name, privacy: .public) \(reason, privacy: .public) at \(path, privacy: .public)")
    }
    /// 응답이나 실시간 프레임 전체를 읽지 못했을 때. 어디서(경로·종류) 무엇이(필드 위치) 어긋났는지만 남긴다.
    static func unreadable(_ source: String, _ error: any Error) {
        let (reason, path) = describe(error, fallback: [])
        logger.error("unreadable \(source, privacy: .public) \(reason, privacy: .public) at \(path, privacy: .public)")
    }
    static func describe(_ error: any Error, fallback: [any CodingKey]) -> (reason: String, path: String) {
        var reason = "other", keys = fallback
        if let decoding = error as? DecodingError {
            switch decoding {
            case .typeMismatch(_, let context): reason = "typeMismatch"; keys = context.codingPath
            case .valueNotFound(_, let context): reason = "valueNotFound"; keys = context.codingPath
            case .keyNotFound(let key, let context): reason = "keyNotFound"; keys = context.codingPath + [key]
            case .dataCorrupted(let context): reason = "dataCorrupted"; keys = context.codingPath
            @unknown default: break
            }
        }
        return (reason, keys.map { key in key.intValue.map { String($0) } ?? key.stringValue }.joined(separator: "."))
    }
}

/// 원소 하나가 어긋나도 배열 전체를 버리지 않게 원소 단위로 읽는다.
private struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) {
        do { value = try T(from: decoder) }
        catch { ContractLog.skipped(T.self, error, fallback: decoder.codingPath); value = nil }
    }
}

extension KeyedDecodingContainer {
    /// 없어도 화면이 성립하는 부가 정보용. 형이 어긋나면 구형 서버처럼 '없음'으로 읽어 동기화 전체를 막지 않는다.
    func lenient<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        do { return try decodeIfPresent(type, forKey: key) }
        catch { ContractLog.skipped(type, error, fallback: codingPath + [key]); return nil }
    }
    /// 읽지 못한 원소만 버린다. 값이 배열이 아니면 그대로 실패한다.
    func lossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T]? {
        try decodeIfPresent([LossyElement<T>].self, forKey: key)?.compactMap(\.value)
    }
    func requiredLossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> [T] {
        guard let items = try lossyArray(type, forKey: key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "Missing required array"))
        }
        return items
    }
    /// 부가 정보 배열: 원소는 하나씩 버리고, 배열 자체가 어긋나면 '없음'.
    func lenientArray<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        do { return try lossyArray(type, forKey: key) }
        catch { ContractLog.skipped([T].self, error, fallback: codingPath + [key]); return nil }
    }
}

extension RankConfig {
    enum CodingKeys: String, CodingKey { case model, effort }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // A JSON null resets the daemon's override; an omitted key would preserve its old value.
        try container.encode(model, forKey: .model)
        try container.encode(effort, forKey: .effort)
    }
}

// New response enums fail closed on future string values. Invalid JSON types still fail decoding.
protocol SafeStringEnum: RawRepresentable, Codable, Sendable where RawValue == String {
    static var unknown: Self { get }
}
extension SafeStringEnum {
    init(from decoder: Decoder) throws {
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? Self.unknown
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

enum MessageScope: Codable, Sendable, Equatable, Hashable {
    case project
    case member(memberId: String)
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case kind, memberId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decodeIfPresent(String.self, forKey: .kind) {
        case "project": self = .project
        case "member": self = .member(memberId: try c.decode(String.self, forKey: .memberId))
        case let kind: self = .unknown(kind ?? "unknown")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .project: try c.encode("project", forKey: .kind)
        case .member(let id):
            try c.encode("member", forKey: .kind)
            try c.encode(id, forKey: .memberId)
        case .unknown(let kind): try c.encode(kind, forKey: .kind)
        }
    }
}

struct MessagePage: Codable, Sendable {
    let projectId: String
    let scope: MessageScope
    let items: [Message]
    let nextCursor: String?
    // Required: a truncated/malformed page must never be interpreted as the end of history.
    let hasOlder: Bool
}

enum OperationStatus: String, SafeStringEnum {
    case pending, applied, refused, unknown
}
enum OperationKind: String, SafeStringEnum {
    case freshSession = "fresh_session", terminalControl = "terminal_control"
    case settings, memberConfig = "member_config", todoDone = "todo_done", unknown
}

struct OperationReceipt: Codable, Sendable {
    let operationId: String
    let kind: OperationKind
    var projectId: String? = nil
    var memberId: String? = nil
    var createdAt: String? = nil
    var updatedAt: String? = nil
    var status: OperationStatus = .unknown
    var code: String? = nil
    var error: String? = nil
    var result: OperationResult? = nil
    /// 넓은 code(TERMINAL_REFUSED 등) 아래의 좁은 사유 코드. 옛 서버의 영수증과 이 앱이 예전에 저장한 영수증에는 없다.
    var reason: String? = nil

    private enum CodingKeys: String, CodingKey {
        case operationId, kind, projectId, memberId, createdAt, updatedAt, status, code, error, result, reason
    }
}
extension OperationReceipt {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        operationId = try c.decode(String.self, forKey: .operationId)
        kind = try c.decodeIfPresent(OperationKind.self, forKey: .kind) ?? .unknown
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        memberId = try c.decodeIfPresent(String.self, forKey: .memberId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        status = try c.decodeIfPresent(OperationStatus.self, forKey: .status) ?? .unknown
        code = try c.decodeIfPresent(String.self, forKey: .code)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        // Unrecognized operations cannot authorize success or replay.
        if kind == .unknown { status = .unknown }
        if status == .applied {
            let resultDecoder = try c.superDecoder(forKey: .result)
            switch kind {
            case .freshSession: result = .freshSession(try FreshSessionResult(from: resultDecoder))
            case .terminalControl: result = .terminalControl(try TerminalControlResultV2(from: resultDecoder))
            case .settings: result = .settings(try SettingsWriteResult(from: resultDecoder))
            case .memberConfig: result = .memberConfig(try MemberConfigWriteResult(from: resultDecoder))
            case .todoDone: result = .todoDone(try TodoWriteResult(from: resultDecoder))
            case .unknown: break
            }
        }
    }
}

enum OperationResult: Encodable, Sendable {
    case freshSession(FreshSessionResult)
    case terminalControl(TerminalControlResultV2)
    case settings(SettingsWriteResult)
    case memberConfig(MemberConfigWriteResult)
    case todoDone(TodoWriteResult)
    func encode(to encoder: Encoder) throws {
        switch self {
        case .freshSession(let value): try value.encode(to: encoder)
        case .terminalControl(let value): try value.encode(to: encoder)
        case .settings(let value): try value.encode(to: encoder)
        case .memberConfig(let value): try value.encode(to: encoder)
        case .todoDone(let value): try value.encode(to: encoder)
        }
    }
}
struct FreshSessionResult: Codable, Sendable { let member: Member; let sessionGeneration: Int }
struct SettingsWriteResult: Codable, Sendable { let settings: Settings; let revision: Int }
struct MemberConfigWriteResult: Codable, Sendable {
    let member: Member
    let configRevision: Int
    let sessionGeneration: Int
}
struct TodoWriteResult: Codable, Sendable { let todo: Todo; let revision: Int }
struct TerminalControlResultV2: Codable, Sendable {
    let memberId: String
    let action: String
    let claimId: String
    let sessionGeneration: Int
    var inputSequence: Int? = nil
    var leaseId: String? = nil
    /// Unix milliseconds, matching the existing TerminalLease wire contract.
    var expiresAt: Double? = nil
}

enum DeliveryRecoveryPhase: String, SafeStringEnum {
    case none, checking, waiting, retryWait = "retry_wait", needsOwner = "needs_owner"
    case resolved, stopped, unknown
}
enum DeliveryRecoveryAction: String, SafeStringEnum {
    case recheck, retryWithRisk = "retry_with_risk", stopRetry = "stop_retry", unknown
}
enum DeliveryRecoveryOutcome: String, SafeStringEnum {
    case checkScheduled = "check_scheduled", retryScheduled = "retry_scheduled", stopped, unknown
}
enum EvidenceVerdict: String, SafeStringEnum { case present, absent, unknown }

struct DeliveryEvidence: Codable, Sendable {
    let source: String
    let verdict: EvidenceVerdict
    let location: String
    let code: String
    let complete: Bool
    let checkedAt: String
}

struct DeliveryNotices: Codable, Sendable, Equatable {
    let version: Int
    let members: [MemberDeliverySummary]
    let unassigned: UnassignedDeliverySummary
    var reportNotices: [MissingReportNotice]? = nil
    var unassignedItems: [UnassignedDeliveryItem]? = nil
}
extension DeliveryNotices {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        version = try c.decode(Int.self, forKey: ModelKey("version"))
        // 한 줄이 어긋나도 나머지 직원의 전달 안내는 남긴다.
        members = try c.lossyArray(MemberDeliverySummary.self, forKey: ModelKey("members")) ?? []
        unassigned = try c.decode(UnassignedDeliverySummary.self, forKey: ModelKey("unassigned"))
        reportNotices = c.lenientArray(MissingReportNotice.self, forKey: ModelKey("reportNotices"))
        unassignedItems = c.lenientArray(UnassignedDeliveryItem.self, forKey: ModelKey("unassignedItems"))
    }
}
enum UnassignedRecoveryAction: String, SafeStringEnum {
    case sendToConductor = "send_to_conductor", dismiss, unknown
}
struct UnassignedDeliveryItem: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let messageId: String
    let projectId: String
    let memberId: String
    let version: Int
    let preview: String
    let createdAt: String
    let allowedActions: [UnassignedRecoveryAction]
}
struct UnassignedRecoveryRequest: Encodable, Sendable {
    let operationId: String
    let expectedVersion: Int
    let action: UnassignedRecoveryAction
}
struct UnassignedRecoveryResult: Codable, Sendable {
    let operationId: String
    let messageId: String
    let deliveryId: String?
    let outcome: String
    let committedVersion: Int
}
struct UnassignedDeliverySummary: Codable, Sendable, Equatable {
    let undeliveredCount: Int
    let unknownCount: Int
    let needsOwnerCount: Int
}
struct MemberDeliverySummary: Codable, Sendable, Equatable {
    let memberId: String
    let undeliveredCount: Int
    let unknownCount: Int
    let deliveringCount: Int
    let checkingCount: Int
    let needsOwnerCount: Int
    let waitingBehindCount: Int
    let oldestAt: String?
    let reasons: [DeliveryReasonCount]
    var waitReason: String? = nil
    var waitingSince: String? = nil
    var runLimit: DeliveryRunLimit? = nil
    var waitReasons: [DeliveryWaitReasonCount]? = nil
}
struct DeliveryReasonCount: Codable, Sendable, Equatable {
    let code: String
    let count: Int
    let note: String
}
extension DeliveryReasonCount {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        code = try c.decode(String.self, forKey: ModelKey("code"))
        count = try c.decode(Int.self, forKey: ModelKey("count"))
        note = try c.decodeIfPresent(String.self, forKey: ModelKey("note")) ?? ""
    }
}
struct DeliveryNoticePage: Codable, Sendable {
    let memberId: String
    let summary: MemberDeliverySummary
    let items: [DeliveryNoticeItem]
    let nextBefore: String?
}
struct DeliveryNoticeItem: Codable, Sendable, Identifiable {
    let id: String
    var deliveryId: String? = nil
    var messageId: String? = nil
    var memberId: String? = nil
    var projectId: String? = nil
    var kind: String? = nil
    var status: String? = nil
    var phase: DeliveryRecoveryPhase? = nil
    var holdReason: String? = nil
    var reason: String? = nil
    var note: String? = nil
    var version: Int? = nil
    var createdAt: String? = nil
    var lastCheckedAt: String? = nil
    var nextCheckAt: String? = nil
    var autoAttempts: Int? = nil
    var evidence: [DeliveryEvidence]? = nil
    var recommendation: DeliveryRecommendation? = nil
    var allowedActions: [DeliveryRecoveryAction]? = nil
    var ref: DeliveryReference? = nil
    var preview: String? = nil
    var waitReason: String? = nil
    var waitingSince: String? = nil
    var runLimit: DeliveryRunLimit? = nil

    /// Future reasons cannot authorize another physical input even if an action is advertised.
    var safeAllowedActions: [DeliveryRecoveryAction] {
        guard let reason, Self.knownReasons.contains(reason), let phase, phase != .unknown else {
            return (allowedActions ?? []).filter { $0 == .recheck || $0 == .stopRetry }
        }
        return (allowedActions ?? []).filter { $0 != .unknown }
    }
    var reasonDescription: String {
        guard let reason, Self.knownReasons.contains(reason) else { return "상세 내용을 확인해 주세요" }
        return note ?? recommendation?.text ?? "상세 내용을 확인해 주세요"
    }
    private static let knownReasons: Set<String> = [
        "blocked", "input_busy", "asleep", "offline", "backend_down", "runner_disabled",
        "archived", "legacy_session", "send_error", "turn_error", "manual_control", "busy",
        "draft_pending", "duplicate_draft", "log_missing", "log_incomplete", "session_unbound",
        "session_lost", "inflight_unsettled", "unsupported_schema", "source_changed", "retry_exhausted",
        "identity_changed", "complete_range_without_marker", "not_received",
        // 서버가 실제로 내보내는 사유. 빠져 있으면 서버의 설명을 버리고 '상세 내용을 확인해 주세요'만 보인다.
        "stalled", "stale_instruction", "legacy_unknown"
    ]
}
struct DeliveryRecommendation: Codable, Sendable { let code: String; let text: String }
struct DeliveryReference: Codable, Sendable { let type: String; let id: String }
struct DeliveryRecoveryRequest: Encodable, Sendable {
    let operationId: String
    let expectedVersion: Int
    let action: DeliveryRecoveryAction
    var acceptDuplicateRisk: Bool? = nil

    private enum CodingKeys: String, CodingKey { case operationId, expectedVersion, action, acceptDuplicateRisk }
    func encode(to encoder: Encoder) throws {
        guard expectedVersion > 0, action != .unknown,
              action == .retryWithRisk ? acceptDuplicateRisk == true : acceptDuplicateRisk == nil else {
            throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Invalid recovery action or precondition"))
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(operationId, forKey: .operationId)
        try c.encode(expectedVersion, forKey: .expectedVersion)
        try c.encode(action, forKey: .action)
        try c.encodeIfPresent(acceptDuplicateRisk, forKey: .acceptDuplicateRisk)
    }
}
struct DeliveryRecoveryResult: Codable, Sendable {
    let operationId: String
    let deliveryId: String
    let outcome: DeliveryRecoveryOutcome
    let committedVersion: Int
}

struct CoreContextState: Codable, Sendable, Equatable {
    var measurement: ContextMeasurement? = nil
    var compaction: ContextCompaction? = nil
}
extension CoreContextState {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        measurement = c.lenient(ContextMeasurement.self, forKey: ModelKey("measurement"))
        compaction = c.lenient(ContextCompaction.self, forKey: ModelKey("compaction"))
    }
}
struct ContextMeasurement: Codable, Sendable, Equatable {
    var sessionId: String? = nil
    var sessionGeneration: Int? = nil
    var turn: Int? = nil
    var model: String? = nil
    var tokens: Int? = nil
    var window: Int? = nil
    var source: String? = nil
    var quality: String? = nil
    var measuredAt: String? = nil
    var fresh: Bool? = nil
}
enum ContextCompactionPhase: String, SafeStringEnum {
    case queued, sending, running, succeeded, failed, uncertain, unknown
}
struct ContextCompaction: Codable, Sendable, Equatable {
    let id: String
    var trigger: String? = nil
    var phase: ContextCompactionPhase? = nil
    var reason: String? = nil
    var requestedAt: String? = nil
    var startedAt: String? = nil
    var finishedAt: String? = nil
}

struct StatusObservation: Codable, Sendable, Equatable {
    var source: String? = nil
    var observedAt: String? = nil
    var freshness: String? = nil
    var ownership: String? = nil
    var consecutiveFailures: Int? = nil
    var error: ObservationError? = nil
}
struct ObservationError: Codable, Sendable, Equatable { let code: String; let note: String }
extension ObservationError {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        code = try c.decode(String.self, forKey: ModelKey("code"))
        note = try c.decodeIfPresent(String.self, forKey: ModelKey("note")) ?? ""
    }
}
struct SubagentState: Codable, Sendable, Equatable {
    var quality: String? = nil
    var count: Int? = nil
    var observedAt: String? = nil
    var sessionGeneration: Int? = nil
}
struct MemberExecutionState: Codable, Sendable, Equatable {
    let runId: String
    var sessionGeneration: Int? = nil
    var turn: Int? = nil
    var deliveryIds: [String]? = nil
    var phase: String? = nil
    var inputReceivedAt: String? = nil
    var startedAt: String? = nil
    var lastProgressAt: String? = nil
    var endedAt: String? = nil
    var result: String? = nil
    var reason: String? = nil
    var exitCode: Int? = nil
}
struct MemberLifecycleState: Codable, Sendable, Equatable {
    let operationId: String
    var sessionGeneration: Int? = nil
    var phase: String? = nil
    var reason: String? = nil
    var updatedAt: String? = nil
}

struct DeliveryRunLimit: Codable, Sendable, Equatable { let used: Int; let limit: Int }
struct MessageDeliveryInfo: Codable, Sendable, Equatable {
    let deliveryId: String
    let memberId: String
    var waitReason: String? = nil
    var waitingSince: String? = nil
    var runLimit: DeliveryRunLimit? = nil
}
struct DeliveryWaitReasonCount: Codable, Sendable, Equatable {
    let waitReason: String
    let waitingSince: String
    var runLimit: DeliveryRunLimit? = nil
    let count: Int
}
struct MissingReportNotice: Codable, Sendable, Identifiable, Equatable {
    var id: String { runId }
    let kind: String
    let runId: String
    let memberId: String
    let messageId: String
    let createdAt: String
    let title: String
}
struct TodoCompletionRequest: Encodable, Sendable {
    let done: Bool
    var note: String? = nil
    var fileIds: [String]? = nil
}

struct TodoDropRequest: Encodable, Sendable { let reason: String? }
