import Foundation

// String-valued server enums deliberately preserve newly introduced daemon values.

struct ProjectConnection: Codable, Sendable {
    var ok: Bool = false
    var reason: String? = nil
    var detail: String? = nil
}
extension ProjectConnection {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: ModelKey("ok")) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: ModelKey("reason"))
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail"))
    }
}

struct Project: Codable, Sendable, Identifiable {
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

struct ProjectSummary: Codable, Sendable, Identifiable {
    var id: String = ""
    var name: String = ""
    var isHq: Bool = false
    var cwd: String = ""
    var now: String = ""
    var runnerEnabled: Bool = false
    var connection: ProjectConnection = ProjectConnection()
    var decisionCount: Int = 0
    var todoCount: Int = 0
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
        inboxCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("inboxCount")) ?? 0
        workingCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("workingCount")) ?? 0
        blockedCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("blockedCount")) ?? 0
        errorCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("errorCount")) ?? 0
        memberCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("memberCount")) ?? 0
    }
}

struct Member: Codable, Sendable, Identifiable {
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
    }
}

struct DecisionOption: Codable, Sendable {
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

struct Decision: Codable, Sendable, Identifiable {
    var id: String = ""
    var projectId: String = ""
    var memberId: String? = nil
    var who: String = ""
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
        title = try c.decodeIfPresent(String.self, forKey: ModelKey("title")) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: ModelKey("detail")) ?? ""
        options = try c.decodeIfPresent([DecisionOption].self, forKey: ModelKey("options")) ?? []
        rec = try c.decodeIfPresent(String.self, forKey: ModelKey("rec"))
        group = try c.decodeIfPresent(String.self, forKey: ModelKey("group"))
        fileId = try c.decodeIfPresent(String.self, forKey: ModelKey("fileId"))
        images = try c.decodeIfPresent([Attachment].self, forKey: ModelKey("images")) ?? []
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

struct Todo: Codable, Sendable, Identifiable {
    var id: String = ""
    var projectId: String = ""
    var memberId: String? = nil
    var who: String = ""
    var title: String = ""
    var detail: String = ""
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
        done = try c.decodeIfPresent(Bool.self, forKey: ModelKey("done")) ?? false
        doneAt = try c.decodeIfPresent(String.self, forKey: ModelKey("doneAt"))
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
        outcome = try c.decodeIfPresent(String.self, forKey: ModelKey("outcome"))
        closeReason = try c.decodeIfPresent(String.self, forKey: ModelKey("closeReason"))
        closedBy = try c.decodeIfPresent(String.self, forKey: ModelKey("closedBy"))
    }
}

struct WorkItem: Codable, Sendable, Identifiable {
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

struct Attachment: Codable, Sendable, Identifiable {
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

struct Message: Codable, Sendable, Identifiable {
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
    var attachments: [Attachment] = []
    var delivery: String? = nil
    var deliveryNote: String? = nil
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
        attachments = try c.decodeIfPresent([Attachment].self, forKey: ModelKey("attachments")) ?? []
        delivery = try c.decodeIfPresent(String.self, forKey: ModelKey("delivery"))
        deliveryNote = try c.decodeIfPresent(String.self, forKey: ModelKey("deliveryNote"))
    }
}

struct FileDoc: Codable, Sendable, Identifiable {
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
        attachments = try c.decodeIfPresent([Attachment].self, forKey: ModelKey("attachments")) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: ModelKey("createdAt")) ?? ""
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

struct RankConfig: Codable, Sendable {
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

struct Settings: Codable, Sendable {
    var backend: String? = nil
    var permissionMode: String = "default"
    var ranks: [String: RankConfig] = [:]
    var maxConcurrentTurns: Int = 4
    var compactAtPct: Int = 70
    var maxAwakeWorkers: Int = 8
    var notifyMac: Bool = false
    var boardTidyHours: Double = 6
}
extension Settings {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        backend = try c.decodeIfPresent(String.self, forKey: ModelKey("backend"))
        permissionMode = try c.decodeIfPresent(String.self, forKey: ModelKey("permissionMode")) ?? "default"
        ranks = try c.decodeIfPresent([String: RankConfig].self, forKey: ModelKey("ranks")) ?? [:]
        maxConcurrentTurns = try c.decodeIfPresent(Int.self, forKey: ModelKey("maxConcurrentTurns")) ?? 4
        compactAtPct = try c.decodeIfPresent(Int.self, forKey: ModelKey("compactAtPct")) ?? 70
        maxAwakeWorkers = try c.decodeIfPresent(Int.self, forKey: ModelKey("maxAwakeWorkers")) ?? 8
        notifyMac = try c.decodeIfPresent(Bool.self, forKey: ModelKey("notifyMac")) ?? false
        boardTidyHours = try c.decodeIfPresent(Double.self, forKey: ModelKey("boardTidyHours")) ?? 6
    }
}

struct HerdrInfo: Codable, Sendable {
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

struct Bootstrap: Codable, Sendable {
    var runtime: RuntimeDiagnostics? = nil
    var version: String = ""
    var settings: Settings = Settings()
    var projects: [ProjectSummary] = []
    var herdr: HerdrInfo = HerdrInfo()
    var home: String = ""
    var urls: [String] = []
    var cli: String = "iamceo"
    var rankOverrides: [String: Int] = [:]
}
extension Bootstrap {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        runtime = try c.decodeIfPresent(RuntimeDiagnostics.self, forKey: ModelKey("runtime"))
        version = try c.decodeIfPresent(String.self, forKey: ModelKey("version")) ?? ""
        settings = try c.decodeIfPresent(Settings.self, forKey: ModelKey("settings")) ?? Settings()
        projects = try c.decode([ProjectSummary].self, forKey: ModelKey("projects"))
        herdr = try c.decodeIfPresent(HerdrInfo.self, forKey: ModelKey("herdr")) ?? HerdrInfo()
        home = try c.decodeIfPresent(String.self, forKey: ModelKey("home")) ?? ""
        urls = try c.decodeIfPresent([String].self, forKey: ModelKey("urls")) ?? []
        cli = try c.decodeIfPresent(String.self, forKey: ModelKey("cli")) ?? "iamceo"
        rankOverrides = try c.decodeIfPresent([String: Int].self, forKey: ModelKey("rankOverrides")) ?? [:]
    }
}

struct ProjectState: Codable, Sendable {
    var project: Project = Project()
    var members: [Member] = []
    var decisions: [Decision] = []
    var doneDecisionCount: Int = 0
    var todos: [Todo] = []
    var work: [WorkItem] = []
    var messages: [Message] = []
    var files: [FileDoc] = []
}
extension ProjectState {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        project = try c.decode(Project.self, forKey: ModelKey("project"))
        members = try c.decodeIfPresent([Member].self, forKey: ModelKey("members")) ?? []
        decisions = try c.decodeIfPresent([Decision].self, forKey: ModelKey("decisions")) ?? []
        doneDecisionCount = try c.decodeIfPresent(Int.self, forKey: ModelKey("doneDecisionCount")) ?? 0
        todos = try c.decodeIfPresent([Todo].self, forKey: ModelKey("todos")) ?? []
        work = try c.decodeIfPresent([WorkItem].self, forKey: ModelKey("work")) ?? []
        messages = try c.decodeIfPresent([Message].self, forKey: ModelKey("messages")) ?? []
        files = try c.decodeIfPresent([FileDoc].self, forKey: ModelKey("files")) ?? []
    }
}

struct CoreRuntime: Codable, Sendable {
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

struct ProviderRuntime: Codable, Sendable {
    var installed: Bool = false
}
extension ProviderRuntime {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ModelKey.self)
        installed = try c.decodeIfPresent(Bool.self, forKey: ModelKey("installed")) ?? false
    }
}

struct RuntimeDiagnostics: Codable, Sendable {
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

extension RankConfig {
    enum CodingKeys: String, CodingKey { case model, effort }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // A JSON null resets the daemon's override; an omitted key would preserve its old value.
        try container.encode(model, forKey: .model)
        try container.encode(effort, forKey: .effort)
    }
}
