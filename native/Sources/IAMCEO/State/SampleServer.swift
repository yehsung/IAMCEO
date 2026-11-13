import Foundation

/// 샘플 모드의 가짜 서버(F8). '샘플로 둘러보기'(iPhone)와 `--demo`(Mac)의 AppStore 는 실제 서버에 붙을 때와 같은 길로
/// 연결·동기화·대화 페이지·쓰기를 하고, 그 요청을 이 서버가 기기 안에서 받는다. 화면 코드는 샘플인지 모르고 그대로 돈다.
///
/// - 자료: `SampleWorkspaceData.json`(서버 시험 tests/sample-workspace.test.ts 가 실제 서버 응답으로 만든다). 불러올 때 모든 시각을
///   '지금' 기준으로 옮겨, 언제 열어도 방금 일하던 팀으로 보인다.
/// - 언어(0.2.5 W): 앱 화면이 영어면 같은 회사·같은 흐름의 영어 자료(`SampleWorkspaceData.english`)로 답하고, 샘플 서버가 지어내는
///   글(팀장의 답글, 활동 줄, 다시 연 결재의 메모)도 영어로 쓴다. 언어는 샘플을 열 때 정해 샘플을 나갈 때까지 그대로다.
/// - 쓰기: 보내기, 결재 답, 할 일 끝내기·정리, 설정, 팀장 모델, 첨부 올리기를 메모리에서만 받는다. 앱을 끄거나 샘플을 나가면 사라진다.
/// - 바깥으로 나가는 길이 없다: 요청은 `SampleURLProtocol`(이 세션의 유일한 프로토콜)이 모두 받고, 다른 주소는 거절한다.
///   주소는 예약된 `.invalid` 이름이라 잘못 새어도 어디에도 닿지 않는다. 실시간 연결도 소켓을 열지 않고 이 서버가 직접 프레임을 넣는다.
final class SampleServer: @unchecked Sendable {
    static let host = "sample.iamceo.invalid"
    static let endpoint = "https://\(host)"
    /// 샘플의 '접속 코드'. 이 서버만 받는다(어디에도 저장하지 않는다).
    static let accessCode = "sample"
    static let headerName = "X-IAMCEO-Sample"

    typealias Object = [String: Any]
    struct Reply { var status = 200; var headers = ["Content-Type": "application/json"]; var body = Data() }

    let id = UUID().uuidString
    /// 이 샘플의 자료와 지어내는 글의 언어(W). 샘플을 열 때의 앱 화면 언어.
    let language: AppLanguage
    private let lock = NSLock()
    private let epoch = "sample"
    private var seq = 1
    private var bootstrap: Object
    private var capabilities: Any
    private var models: Any
    private var runtime: Any
    private var settingsRevision: Int
    private var projects: [String: Project] = [:]
    private var files: [String: Object]
    private var artifacts: [String: String]
    /// 시안 화면이 여는 render=1 문서와 그 정책 머리글(실제 서버 응답 그대로).
    private var artifactDocuments: [String: String]
    private var artifactPolicy: String
    private var blobs: [String: (mime: String, data: Data)] = [:]
    private var uploads: [String: Object] = [:]
    private var usage: [String: Any]
    private var sockets: [UUID: SampleRealtimeTransport] = [:]
    private var activitySeq = 1000
    private var captured: [URLRequest] = []
    /// 보낸 글이 '전달됨'이 되고 팀장이 받았다고 답하기까지의 간격. 시험이 줄인다.
    var deliveryDelay: Duration = .milliseconds(700)
    var replyDelay: Duration = .milliseconds(2600)
    /// 실시간 연결의 심장 박동 간격(서버와 같다).
    var heartbeat: Duration = .seconds(15)

    private struct Project {
        var state: Object
        var revisions: Object
        var messages: [Object]
        var deliveryNotices: Any
        var activity: [String: [Object]]
        var memberNotices: [String: Any]
    }

    /// 이 서버로만 가는 세션 설정(첨부 올리기도 이것을 쓴다). 바깥 망·쿠키·자격 증명·캐시를 쓰지 않는다.
    var configuration: URLSessionConfiguration { Self.configuration(id: id) }
    private static func configuration(id: String) -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SampleURLProtocol.self]
        config.httpAdditionalHeaders = [Self.headerName: id]
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 30
        return config
    }
    let session: URLSession
    var realtimeFactory: any RealtimeTransportFactory { SampleRealtimeFactory(server: self) }
    /// 이 서버가 받은 요청(시험이 '바깥으로 나가지 않았다'를 확인한다).
    var requests: [URLRequest] { lock.withLock { captured } }

    init(now: Date = Date(), language: AppLanguage = .current) {
        self.language = language
        let data = SampleWorkspace.load(now: now, language: language)
        bootstrap = data["bootstrap"] as? Object ?? [:]
        capabilities = data["capabilities"] ?? [:]
        models = data["models"] ?? [:]
        runtime = data["runtime"] ?? [:]
        settingsRevision = data["settingsRevision"] as? Int ?? 1
        files = data["files"] as? [String: Object] ?? [:]
        artifacts = data["artifacts"] as? [String: String] ?? [:]
        artifactDocuments = data["artifactDocuments"] as? [String: String] ?? [:]
        artifactPolicy = data["artifactPolicy"] as? String ?? "sandbox allow-scripts; default-src 'none'"
        usage = data["usage"] as? [String: Any] ?? [:]
        for (path, value) in data["blobs"] as? [String: Object] ?? [:] {
            if let mime = value["mime"] as? String, let base64 = value["base64"] as? String, let bytes = Data(base64Encoded: base64) {
                blobs[path] = (mime, bytes)
            }
        }
        for (pid, value) in data["projects"] as? [String: Object] ?? [:] {
            projects[pid] = Project(state: value["state"] as? Object ?? [:], revisions: value["revisions"] as? Object ?? [:],
                                    messages: value["messages"] as? [Object] ?? [], deliveryNotices: value["deliveryNotices"] ?? [:],
                                    activity: value["activity"] as? [String: [Object]] ?? [:], memberNotices: value["memberNotices"] as? [String: Any] ?? [:])
        }
        session = URLSession(configuration: Self.configuration(id: id))
        SampleServerRegistry.shared.add(self)
    }
    deinit { SampleServerRegistry.shared.remove(id) }

    /// 앱을 바꿔 끼울 때(샘플을 나갈 때) 열린 실시간 연결을 닫는다.
    func shutdown() {
        let open = lock.withLock { () -> [SampleRealtimeTransport] in defer { sockets.removeAll() }; return Array(sockets.values) }
        open.forEach { $0.finish() }
        session.getAllTasks { $0.forEach { $0.cancel() } }
    }

    // MARK: - 요청

    func reply(to request: URLRequest, body: Data?) -> Reply {
        lock.withLock { captured.append(request) }
        guard let url = request.url, url.scheme == "https", url.host == Self.host, url.port == nil,
              url.user == nil, url.password == nil else {
            return Self.json(["error": "샘플 서버 밖의 주소입니다.", "code": "sample_foreign"], status: 421)
        }
        guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Self.accessCode)" else {
            return fail("unauthorized", status: 401)
        }
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = Dictionary((parts?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        let path = url.path
        let segments = path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        let method = request.httpMethod ?? "GET"
        let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? Object ?? [:]
        return lock.withLock { route(method: method, path: path, segments: segments, query: query, input: input, request: request, body: body) }
    }

    private func route(method: String, path: String, segments s: [String], query: [String: String], input: Object, request: URLRequest, body: Data?) -> Reply {
        let lite = query["lite"] == "1"
        switch (method, s.count) {
        case ("GET", _) where path == "/api/health": return Self.json(["ok": true, "version": "sample"])
        case ("GET", _) where path == "/api/capabilities": return Self.json(capabilities)
        case ("GET", _) where path == "/api/models": return Self.json(models)
        case ("GET", _) where path == "/api/runtime": return Self.json(runtime)
        case ("GET", _) where path == "/api/bootstrap": return Self.json(currentBootstrap(withRuntime: true))
        case ("GET", _) where path == "/api/sync": return Self.json(sync(projectID: query["projectId"], lite: lite))
        case ("GET", _) where path == "/api/projects/archived": return Self.json([Any]())
        case ("GET", _) where path == "/api/usage":
            // T(F6): 오늘·7일·30일의 사용량(서버 시험이 실제 서버로 만든 보고). 다른 기간은 가장 가까운 것.
            let days = Int(query["days"] ?? "") ?? 7
            let key = ["1", "7", "30"].min { abs((Int($0) ?? 7) - days) < abs((Int($1) ?? 7) - days) } ?? "7"
            return usage[key].map { Self.json($0) } ?? missing()
        case ("PUT", _) where path == "/api/settings", ("PATCH", _) where path == "/api/settings":
            return writeSettings(input, versioned: request.value(forHTTPHeaderField: "X-IAMCEO-Contract") == "2")
        case ("POST", _) where path == "/api/uploads": return upload(request: request, body: body ?? Data())
        default: break
        }
        if method == "GET", let blob = blobs[path] {
            return Reply(headers: ["Content-Type": blob.mime, "Content-Length": String(blob.data.count)], body: blob.data)
        }
        guard s.count >= 3, s[0] == "api" else { return missing() }
        let versioned = request.value(forHTTPHeaderField: "X-IAMCEO-Contract") == "2"
        switch (method, s[1], s.count) {
        case ("GET", "projects", 4) where s[3] == "state":
            guard let project = projects[s[2]] else { return missing("project_not_found") }
            return Self.json(state(of: project, lite: lite))
        case ("GET", "projects", 5) where s[3] == "messages" && s[4] == "page":
            return messagePage(projectID: s[2], query: query)
        case ("GET", "projects", 4) where s[3] == "messages":
            guard let project = projects[s[2]] else { return missing("project_not_found") }
            guard let around = query["around"], let index = project.messages.firstIndex(where: { $0["id"] as? String == around }) else { return missing("message_not_found") }
            let limit = Int(query["limit"] ?? "") ?? 41
            let lower = max(0, index - limit / 2), upper = min(project.messages.count, lower + limit)
            return Self.json(Array(project.messages[lower..<upper]))
        case ("GET", "projects", 4) where s[3] == "decisions":
            guard let project = projects[s[2]] else { return missing("project_not_found") }
            let done = decisions(of: project).filter { ($0["status"] as? String) != "open" }
                .sorted { ($0["updatedAt"] as? String ?? "") > ($1["updatedAt"] as? String ?? "") }
            return Self.json(Array(done.prefix(Int(query["limit"] ?? "") ?? 50)))
        case ("GET", "projects", 4) where s[3] == "delivery-notices":
            guard let project = projects[s[2]] else { return missing("project_not_found") }
            return Self.json(project.deliveryNotices)
        case ("GET", "projects", 5) where s[3] == "files" && s[4] == "search":
            return searchFiles(projectID: s[2], query: query["q"] ?? "")
        case ("POST", "projects", 4) where s[3] == "messages":
            return sendMessage(projectID: s[2], input: input)
        case ("GET", "messages", 3):
            guard let message = projects.values.lazy.compactMap({ $0.messages.first { $0["id"] as? String == s[2] } }).first else { return missing("message_not_found") }
            return Self.json(message)
        case ("GET", "decisions", 3):
            guard let decision = projects.values.lazy.compactMap({ project in self.decisions(of: project).first { $0["id"] as? String == s[2] } }).first else { return missing("decision_not_found") }
            return Self.json(decision)
        case ("POST", "decisions", 4) where s[3] == "answer":
            return answerDecision(id: s[2], input: input)
        case ("POST", "decisions", 4) where s[3] == "reopen":
            return reopenDecision(id: s[2])
        case ("POST", "todos", 4) where s[3] == "done" || s[3] == "drop":
            return writeTodo(id: s[2], drop: s[3] == "drop", input: input, versioned: versioned)
        case ("GET", "files", 3):
            guard let file = files[s[2]] else { return missing("file_not_found") }
            return Self.json(file)
        case ("GET", "files", 4) where s[3] == "artifact":
            guard let html = artifacts[s[2]] else { return missing("file_not_found") }
            // 앱의 시안 화면은 render=1 로 실제 서버가 감싼 문서(srcdoc)와 격리 정책 머리글을 받아야 연다(4차 리뷰 data-3).
            // 문서와 정책은 서버 시험이 실제 서버의 render=1 응답으로 담는다.
            if query["render"] == "1" {
                guard let document = artifactDocuments[s[2]] else { return missing("file_not_found") }
                return Reply(headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": artifactPolicy,
                                       "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"], body: Data(document.utf8))
            }
            return Self.json(["html": html])
        case ("GET", "members", 3):
            guard let member = member(id: s[2]) else { return missing("member_not_found") }
            return Self.json(member.value)
        case ("GET", "members", 4) where s[3] == "activity":
            guard let found = member(id: s[2]) else { return missing("member_not_found") }
            let rows = projects[found.projectID]?.activity[s[2]] ?? []
            return Self.json(rows.sorted { ($0["id"] as? Int ?? 0) < ($1["id"] as? Int ?? 0) })
        case ("GET", "members", 4) where s[3] == "delivery-notices":
            guard let found = member(id: s[2]) else { return missing("member_not_found") }
            return Self.json(projects[found.projectID]?.memberNotices[s[2]] ?? ["memberId": s[2], "items": [Any](), "nextBefore": NSNull()])
        case ("PATCH", "members", 3):
            return writeMember(id: s[2], input: input, versioned: versioned)
        case ("POST", "members", 4) where ["sleep", "resume", "interrupt", "compact"].contains(s[3]):
            return memberAction(id: s[2], action: s[3])
        case ("POST", "projects", 4) where s[3] == "tidy":
            guard projects[s[2]] != nil else { return missing("project_not_found") }
            // 판 정리는 총괄에게 맡기는 일이다. 샘플에서는 맡겼다는 답만 한다(진행판은 그대로).
            return Self.json(["already": false])
        default:
            // 샘플에 없는 기능(새 프로젝트, 터미널, 알림 기기 등). 화면은 이런 동작을 샘플에서 내보이지 않는다.
            return method == "GET" ? missing() : Self.json(["error": String(localized: "샘플에서는 할 수 없는 동작입니다. 실제 Mac에 연결하면 할 수 있습니다."), "code": "sample_unsupported"], status: 501)
        }
    }

    // MARK: - 읽기

    private func currentBootstrap(withRuntime: Bool) -> Object {
        var value = bootstrap
        if !withRuntime { value.removeValue(forKey: "runtime") }
        // 샘플 서버는 앱 안에 있어 늘 이 앱과 같은 단계다. 버전 머리글을 받은 실제 서버처럼 자기 단계를 싣는다.
        // 없으면 앱의 API 단계가 오를 때 '서버가 옛 버전' 줄이 샘플에 늘 뜬다(4차 리뷰 ui-8).
        value["server"] = ["version": "sample", "apiLevel": AppVersion.apiLevel]
        value["projects"] = (bootstrap["projects"] as? [Object] ?? []).map { summary in
            guard let pid = summary["id"] as? String, let project = projects[pid] else { return summary }
            var next = summary
            let open = decisions(of: project).filter { $0["status"] as? String == "open" }.count
            let todos = (project.state["todos"] as? [Object] ?? []).filter { $0["done"] as? Bool != true }.count
            let members = project.state["members"] as? [Object] ?? []
            next["decisionCount"] = open; next["todoCount"] = todos
            next["inboxCount"] = open + todos; next["needsCount"] = open + todos
            next["workingCount"] = members.filter { $0["status"] as? String == "working" }.count
            next["memberCount"] = members.count
            if let now = (project.state["project"] as? Object)?["now"] { next["now"] = now }
            return next
        }
        return value
    }

    private func decisions(of project: Project) -> [Object] { project.state["decisions"] as? [Object] ?? [] }

    private func state(of project: Project, lite: Bool) -> Object {
        var value = project.state
        value["messages"] = Array(project.messages.suffix(50))
        value["doneDecisionCount"] = decisions(of: project).filter { ($0["status"] as? String) != "open" }.count
        if lite { value["files"] = (value["files"] as? [Object] ?? []).map { file in var file = file; file.removeValue(forKey: "body"); return file } }
        return value
    }

    private func sync(projectID: String?, lite: Bool) -> Object {
        var value: Object = ["protocol": 2, "cursor": ["epoch": epoch, "seq": seq], "apiOutage": NSNull(), "bootstrap": currentBootstrap(withRuntime: false)]
        if let projectID, let project = projects[projectID] {
            value["requestedProjectId"] = projectID
            value["projectStatus"] = "ok"
            value["state"] = state(of: project, lite: lite)
            var revisions = project.revisions
            revisions["settings"] = settingsRevision
            value["revisions"] = revisions
        } else {
            value["requestedProjectId"] = projectID ?? NSNull()
            value["projectStatus"] = projectID == nil ? "none" : "not_found"
            value["state"] = NSNull()
            value["revisions"] = ["settings": settingsRevision, "members": Object(), "todos": Object()]
        }
        return value
    }

    private func messagePage(projectID: String, query: [String: String]) -> Reply {
        guard let project = projects[projectID] else { return missing("project_not_found") }
        var scope: Object = ["kind": "project"]
        var rows = project.messages
        if query["scope"] == "member", let memberID = query["memberId"] {
            // 총괄과의 대화는 프로젝트 전체 대화다(서버와 같은 규칙).
            let kind = (project.state["members"] as? [Object] ?? []).first { $0["id"] as? String == memberID }?["kind"] as? String
            if kind != "conductor" {
                scope = ["kind": "member", "memberId": memberID]
                rows = rows.filter { $0["memberId"] as? String == memberID || $0["targetMemberId"] as? String == memberID }
            }
        }
        // 샘플의 대화는 짧다. 한 페이지에 모두 싣고 더 오래된 기록은 없다고 답한다.
        return Self.json(["projectId": projectID, "scope": scope, "items": rows, "nextCursor": NSNull(), "hasOlder": false])
    }

    private func searchFiles(projectID: String, query: String) -> Reply {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return Self.json([Any]()) }
        var results: [Object] = []
        for file in (projects[projectID]?.state["files"] as? [Object] ?? []) {
            guard let fid = file["id"] as? String else { continue }
            let full = files[fid] ?? file
            let title = [full["title"], full["path"], full["summary"]].compactMap { $0 as? String }.first { $0.localizedCaseInsensitiveContains(term) }
            let body = full["body"] as? String ?? ""
            guard title != nil || body.localizedCaseInsensitiveContains(term) else { continue }
            let excerpt = title ?? body.components(separatedBy: "\n").first { $0.localizedCaseInsensitiveContains(term) } ?? ""
            results.append(["id": fid, "match": title == nil ? "body" : "title", "excerpt": String(excerpt.prefix(200)), "rank": results.count + 1])
        }
        return Self.json(results)
    }

    private func member(id: String) -> (projectID: String, index: Int, value: Object)? {
        for (pid, project) in projects {
            let members = project.state["members"] as? [Object] ?? []
            if let index = members.firstIndex(where: { $0["id"] as? String == id }) { return (pid, index, members[index]) }
        }
        return nil
    }

    // MARK: - 쓰기(메모리에서만)

    private func sendMessage(projectID: String, input: Object) -> Reply {
        guard var project = projects[projectID] else { return missing("project_not_found") }
        let messageID = input["id"] as? String ?? UUID().uuidString
        // 같은 id 로 다시 보내면 처음 받은 글을 돌려준다(실제 서버와 같다).
        if let existing = project.messages.first(where: { $0["id"] as? String == messageID }) { return Self.json(existing) }
        let text = input["text"] as? String ?? ""
        let attachmentIDs = input["attachmentIds"] as? [String] ?? []
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty else {
            return fail("message_empty", status: 400)
        }
        let members = project.state["members"] as? [Object] ?? []
        let targetID = input["targetMemberId"] as? String
        let target = targetID.flatMap { id in members.first { $0["id"] as? String == id } }
        if targetID != nil, target == nil { return fail("member_not_in_project", status: 400) }
        let message: Object = [
            "id": messageID, "projectId": projectID, "at": Self.timestamp(), "mine": true, "memberId": NSNull(), "who": "나", "kind": "나",
            "title": "", "body": text, "targetMemberId": targetID ?? NSNull(), "targetName": target?["name"] ?? NSNull(),
            "decisionId": NSNull(), "fileId": NSNull(), "attachments": attachmentIDs.compactMap { uploads[$0] },
            "delivery": "queued", "deliveryNote": NSNull(), "deliveryRevision": 0, "contextFileId": input["contextFileId"] ?? NSNull(),
            "fileIds": [Any](), "supersedes": NSNull(), "supersededBy": NSNull(),
        ]
        project.messages.append(message)
        projects[projectID] = project
        changed()
        // 받은 팀장(받는 사람이 없으면 총괄)이 곧 받고, 조금 뒤 받았다고 답한다. 샘플이 살아 있는 팀처럼 보이게.
        let recipient = target ?? members.first { $0["kind"] as? String == "conductor" }
        let recipientID = recipient?["id"] as? String, recipientName = recipient?["name"] as? String ?? ""
        later(deliveryDelay) { server in server.deliver(messageID: messageID, projectID: projectID, recipientID: recipientID, text: text) }
        if let recipientID {
            later(replyDelay) { server in server.acknowledge(projectID: projectID, memberID: recipientID, name: recipientName, text: text) }
        }
        return Self.json(message)
    }

    private func deliver(messageID: String, projectID: String, recipientID: String?, text: String) {
        guard var project = projects[projectID], let index = project.messages.firstIndex(where: { $0["id"] as? String == messageID }) else { return }
        project.messages[index]["delivery"] = "delivered"
        project.messages[index]["deliveryRevision"] = (project.messages[index]["deliveryRevision"] as? Int ?? 0) + 1
        if let recipientID, var members = project.state["members"] as? [Object], let at = members.firstIndex(where: { $0["id"] as? String == recipientID }) {
            let now = Self.timestamp()
            members[at]["status"] = "working"
            members[at]["now"] = (language == .en ? "Your instruction: " : "대표 지시: ") + Self.oneLine(text, limit: 40)
            members[at]["nowAt"] = now; members[at]["updatedAt"] = now; members[at]["lastActiveAt"] = now
            project.state["members"] = members
            activitySeq += 1
            project.activity[recipientID, default: []].append(["id": activitySeq, "memberId": recipientID, "at": now, "kind": "turn_start",
                                                               "text": (language == .en ? "Got the instruction: " : "지시를 받았습니다: ") + Self.oneLine(text, limit: 60)])
        }
        projects[projectID] = project
        changed()
    }

    /// 영어 샘플 팀장의 답글. 인용한 지시가 문장 끝에 오지 않게 하고, 지시 끝의 마침표·물음표·느낌표는 뗀다
    /// (리뷰 lang-3: “….”. 처럼 문장 부호가 겹치지 않게). 60자를 넘어 줄인 지시의 … 는 남긴다.
    static func englishAcknowledgement(_ text: String) -> String {
        var quote = oneLine(text, limit: 60)
        while let last = quote.last, ".?!。".contains(last) { quote.removeLast() }
        quote = quote.trimmingCharacters(in: .whitespaces)
        return "Got it. I'll wrap up what I'm doing and start right away on “\(quote)”, then report back when it's done."
    }

    private func acknowledge(projectID: String, memberID: String, name: String, text: String) {
        guard var project = projects[projectID] else { return }
        let reply: Object = [
            "id": "sample-" + UUID().uuidString.lowercased(), "projectId": projectID, "at": Self.timestamp(), "mine": false,
            "memberId": memberID, "who": name, "kind": "진행", "title": language == .en ? "Instruction received" : "지시를 받았습니다",
            "body": language == .en
                ? Self.englishAcknowledgement(text)
                : "‘\(Self.oneLine(text, limit: 60))’ 지시를 받았습니다. 하던 일을 정리하고 바로 이어서 하겠습니다. 끝나면 결과를 보고드리겠습니다.",
            "targetMemberId": NSNull(), "targetName": NSNull(), "decisionId": NSNull(), "fileId": NSNull(), "attachments": [Any](),
            "delivery": NSNull(), "deliveryNote": NSNull(), "deliveryRevision": 0, "contextFileId": NSNull(), "fileIds": [Any](),
            "supersedes": NSNull(), "supersededBy": NSNull(),
        ]
        project.messages.append(reply)
        projects[projectID] = project
        changed()
    }

    private func answerDecision(id: String, input: Object) -> Reply {
        guard let (pid, index) = decisionIndex(id), var project = projects[pid], var list = project.state["decisions"] as? [Object] else {
            return missing("decision_not_found")
        }
        var decision = list[index]
        guard decision["status"] as? String == "open" else {
            // 같은 답을 다시 보낸 것이면 그대로 돌려준다. 다른 답이면 이미 정해졌다고 알린다.
            if decision["choice"] as? String == input["choice"] as? String { return Self.json(decision) }
            return fail("decision_closed", status: 409)
        }
        let now = Self.timestamp()
        decision["status"] = "answered"
        decision["choice"] = input["choice"] ?? NSNull()
        decision["note"] = (input["note"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        decision["batch"] = input["batch"] as? Bool ?? false
        decision["answeredAt"] = now; decision["updatedAt"] = now
        list[index] = decision
        project.state["decisions"] = list
        projects[pid] = project
        changed()
        // 실제 서버처럼 답은 곧 물은 팀장에게 전달된다.
        later(deliveryDelay) { server in server.markDelivered(decisionID: id) }
        return Self.json(decision)
    }

    /// 결재됨의 '다시 열기'(4차 리뷰 ui-1). 실제 서버(flows/owner.ts·store.reopenDecision)와 같게: AI 가 닫은 결재만 열고,
    /// 직전 답을 last* 로 옮기고 닫은 표시를 지운다.
    private func reopenDecision(id: String) -> Reply {
        guard let (pid, index) = decisionIndex(id), var project = projects[pid], var list = project.state["decisions"] as? [Object] else {
            return missing("decision_not_found")
        }
        var decision = list[index]
        guard decision["status"] as? String == "closed", let kind = decision["closeKind"] as? String, !kind.isEmpty else {
            return fail("decision_reopen_refused", status: 409)
        }
        let closer = decision["closedBy"] as? String ?? "AI"
        let reason = (decision["closeReason"] as? String).map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") } ?? ""
        if language == .en {
            decision["reopenNote"] = "You reopened a decision closed by \(closer)" + (reason.isEmpty ? "" : " (reason it was closed: \(reason))")
        } else {
            let particle = closer.unicodeScalars.last.map { (0xAC00...0xD7A3).contains($0.value) && ($0.value - 0xAC00) % 28 != 0 } == true ? "이" : "가"
            decision["reopenNote"] = "\(closer)\(particle) 닫았던 결재를 대표가 다시 열었습니다" + (reason.isEmpty ? "" : "(닫은 이유: \(reason))")
        }
        if let choice = decision["choice"] as? String { decision["lastChoice"] = choice }
        if let note = decision["note"] as? String { decision["lastNote"] = note }
        decision["status"] = "open"
        for key in ["choice", "note", "answeredAt", "deliveredAt", "closeKind", "closeReason", "closeQuote", "closedBy", "closedAt"] {
            decision[key] = NSNull()
        }
        decision["batch"] = false
        decision["updatedAt"] = Self.timestamp()
        list[index] = decision
        project.state["decisions"] = list
        projects[pid] = project
        changed()
        return Self.json(decision)
    }

    private func markDelivered(decisionID: String) {
        guard let (pid, index) = decisionIndex(decisionID), var project = projects[pid], var list = project.state["decisions"] as? [Object],
              list[index]["status"] as? String == "answered" else { return }
        let now = Self.timestamp()
        list[index]["status"] = "delivered"; list[index]["deliveredAt"] = now; list[index]["updatedAt"] = now
        project.state["decisions"] = list
        projects[pid] = project
        changed()
    }

    private func decisionIndex(_ id: String) -> (String, Int)? {
        for (pid, project) in projects {
            if let index = decisions(of: project).firstIndex(where: { $0["id"] as? String == id }) { return (pid, index) }
        }
        return nil
    }

    private func writeTodo(id: String, drop: Bool, input: Object, versioned: Bool) -> Reply {
        for (pid, var project) in projects {
            guard var todos = project.state["todos"] as? [Object], let index = todos.firstIndex(where: { $0["id"] as? String == id }) else { continue }
            let now = Self.timestamp()
            var todo = todos[index]
            let done = drop ? true : (input["done"] as? Bool ?? true)
            todo["done"] = done
            todo["doneAt"] = done ? now : NSNull()
            todo["outcome"] = done ? (drop ? "dropped" : "done") : NSNull()
            if drop { todo["closeReason"] = input["reason"] ?? NSNull(); todo["closedBy"] = language == .en ? "you" : "나" }
            if !drop, done, let note = input["note"] as? String, !note.isEmpty { todo["completionNote"] = note }
            if !done { todo["completionNote"] = NSNull(); todo["closeReason"] = NSNull(); todo["closedBy"] = NSNull() }
            todos[index] = todo
            project.state["todos"] = todos
            var revisions = project.revisions["todos"] as? Object ?? [:]
            let revision = (revisions[id] as? Int ?? 0) + 1
            revisions[id] = revision
            project.revisions["todos"] = revisions
            projects[pid] = project
            changed()
            return Self.json(versioned ? ["todo": todo, "revision": revision] : todo)
        }
        return missing("todo_not_found")
    }

    private func writeSettings(_ input: Object, versioned: Bool) -> Reply {
        var settings = bootstrap["settings"] as? Object ?? [:]
        for (key, value) in input {
            if key == "ranks" || key == "codexRanks", let patch = value as? Object {
                var ranks = settings[key] as? Object ?? [:]
                for (rank, change) in patch {
                    var current = ranks[rank] as? Object ?? [:]
                    for (field, item) in change as? Object ?? [:] { current[field] = item }
                    ranks[rank] = current
                }
                settings[key] = ranks
            } else { settings[key] = value }
        }
        bootstrap["settings"] = settings
        settingsRevision += 1
        changed()
        return Self.json(versioned ? ["settings": settings, "revision": settingsRevision] : settings)
    }

    private func writeMember(id: String, input: Object, versioned: Bool) -> Reply {
        guard let found = member(id: id), var project = projects[found.projectID], var members = project.state["members"] as? [Object] else { return missing("member_not_found") }
        var member = members[found.index]
        for key in ["cli", "modelOverride", "effortOverride"] where input.keys.contains(key) { member[key] = input[key] }
        member["updatedAt"] = Self.timestamp()
        members[found.index] = member
        project.state["members"] = members
        var revisions = project.revisions["members"] as? Object ?? [:]
        var revision = revisions[id] as? Object ?? ["configRevision": 0, "sessionGeneration": 1]
        revision["configRevision"] = (revision["configRevision"] as? Int ?? 0) + 1
        revisions[id] = revision
        project.revisions["members"] = revisions
        projects[found.projectID] = project
        changed()
        guard versioned else { return Self.json(member) }
        return Self.json(["member": member, "configRevision": revision["configRevision"] ?? 1, "sessionGeneration": revision["sessionGeneration"] ?? 1])
    }

    /// 팀장 상세의 재우기·깨우기·멈추기·문맥 압축. 상태만 바꾼다.
    private func memberAction(id: String, action: String) -> Reply {
        guard let found = member(id: id), var project = projects[found.projectID], var members = project.state["members"] as? [Object] else { return missing("member_not_found") }
        var member = members[found.index]
        let now = Self.timestamp()
        switch action {
        case "sleep": member["status"] = "asleep"; member["now"] = ""; member["nowAt"] = NSNull(); member["subagents"] = 0
        case "resume", "interrupt": member["status"] = "idle"
        default:
            // 압축은 실제처럼 '도는 중'을 거쳐 끝난다. 앱은 새 압축 기록이 끝난 것을 보고 확인을 마친다.
            var context = member["contextState"] as? Object ?? [:]
            context["compaction"] = ["id": "sample-" + UUID().uuidString.lowercased(), "trigger": "manual", "phase": "running", "reason": NSNull(),
                                     "requestedAt": now, "startedAt": now, "finishedAt": NSNull()]
            member["contextState"] = context
            later(deliveryDelay * 2) { server in server.finishCompaction(memberID: id) }
        }
        member["updatedAt"] = now
        members[found.index] = member
        project.state["members"] = members
        projects[found.projectID] = project
        changed()
        return Self.json(member)
    }

    private func finishCompaction(memberID: String) {
        guard let found = member(id: memberID), var project = projects[found.projectID], var members = project.state["members"] as? [Object] else { return }
        var member = members[found.index]
        var context = member["contextState"] as? Object ?? [:]
        guard var compaction = context["compaction"] as? Object, compaction["phase"] as? String == "running" else { return }
        let now = Self.timestamp()
        compaction["phase"] = "succeeded"; compaction["finishedAt"] = now
        context["compaction"] = compaction
        let pct = 6
        if var measurement = context["measurement"] as? Object {
            let window = measurement["window"] as? Int ?? 200_000
            measurement["tokens"] = window * pct / 100; measurement["measuredAt"] = now
            context["measurement"] = measurement
        }
        member["contextState"] = context
        member["contextPct"] = pct
        member["updatedAt"] = now
        members[found.index] = member
        project.state["members"] = members
        projects[found.projectID] = project
        changed()
    }

    private func upload(request: URLRequest, body: Data) -> Reply {
        guard let type = request.value(forHTTPHeaderField: "Content-Type"), let range = type.range(of: "boundary=") else {
            return fail("multipart_required", status: 400)
        }
        let boundary = Data(("--" + type[range.upperBound...].trimmingCharacters(in: CharacterSet(charactersIn: "\""))).utf8)
        let separator = Data("\r\n\r\n".utf8)
        guard let start = body.range(of: boundary), let headerEnd = body.range(of: separator, in: start.upperBound..<body.endIndex),
              let end = body.range(of: Data("\r\n".utf8) + boundary, in: headerEnd.upperBound..<body.endIndex) else {
            return fail("upload_file_missing", status: 400)
        }
        let header = String(decoding: body[start.upperBound..<headerEnd.lowerBound], as: UTF8.self)
        let name = header.range(of: "filename=\"").flatMap { open in header[open.upperBound...].split(separator: "\"").first.map(String.init) } ?? "file"
        let mime = header.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-type:") }
            .map { String($0.dropFirst("content-type:".count)).trimmingCharacters(in: .whitespaces) } ?? "application/octet-stream"
        let bytes = Data(body[headerEnd.upperBound..<end.lowerBound])
        let attachmentID = "sample-" + UUID().uuidString.lowercased()
        let url = "/files/\(attachmentID)/" + (name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "file")
        // 받을 때는 디코딩한 경로(URL.path)로 찾는다. 한글·띄어쓰기 이름(iPhone 사진 '사진-…')도 같은 열쇠가 되게
        // 디코딩한 경로로 넣는다(4차 리뷰 ui-2).
        blobs[url.removingPercentEncoding ?? url] = (mime, bytes)
        let attachment: Object = ["id": attachmentID, "name": name, "mime": mime, "size": bytes.count, "url": url, "path": "", "isImage": mime.hasPrefix("image/")]
        uploads[attachmentID] = attachment
        return Self.json(attachment)
    }

    // MARK: - 실시간

    /// 무엇이든 바뀌면 순번을 올리고 열린 연결에 알린다. 앱은 순번이 오른 ping 을 받으면 최신 상태를 다시 읽는다(실제 서버의 규약).
    private func changed() {
        seq += 1
        let frame = Self.encode(["type": "ping", "epoch": epoch, "seq": seq])
        sockets.values.forEach { $0.enqueue(frame) }
    }

    fileprivate func openSocket() -> SampleRealtimeTransport {
        let transport = SampleRealtimeTransport()
        let socketID = transport.id
        transport.onClose = { [weak self] in
            guard let self else { return }
            self.lock.withLock { _ = self.sockets.removeValue(forKey: socketID) }
        }
        let pause = lock.withLock { heartbeat }
        transport.pulse = Task { [weak self, weak transport] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: pause) } catch { return }
                guard let self, let transport else { return }
                self.lock.withLock { transport.enqueue(Self.encode(["type": "ping", "epoch": self.epoch, "seq": self.seq])) }
            }
        }
        // hello 와 등록을 한 잠금 안에서 한다. 그 사이의 변경 알림이 hello 보다 앞서거나 빠지지 않는다.
        lock.withLock {
            sockets[socketID] = transport
            transport.enqueue(Self.encode(["type": "hello", "protocol": 2, "epoch": epoch, "seq": seq, "heartbeatMs": 15_000, "staleAfterMs": 45_000]))
        }
        return transport
    }

    private func later(_ delay: Duration, _ action: @escaping @Sendable (SampleServer) -> Void) {
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self else { return }
            self.lock.withLock { action(self) }
        }
    }

    // MARK: - 도움

    /// 실제 서버처럼 코드와 그 코드의 대표 문장을 싣는다. 그래서 영어 화면에서는 앱이 코드의 영어 문장을 고른다(4차 리뷰 lang-7).
    private func fail(_ code: String, status: Int) -> Reply {
        Self.json(["error": ServerErrorText.text(code, language: .ko) ?? code, "code": code], status: status)
    }
    private func missing(_ code: String = "not_found") -> Reply { fail(code, status: 404) }
    static func json(_ value: Any, status: Int = 200) -> Reply {
        Reply(status: status, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: encode(value))
    }
    static func encode(_ value: Any) -> Data { (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("{}".utf8) }
    static func timestamp(_ date: Date = Date()) -> String { SampleWorkspace.format(date) }
    static func oneLine(_ text: String, limit: Int) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return line.count > limit ? String(line.prefix(limit)) + "…" : line
    }
}

/// 샘플 자료를 불러와 시각을 '지금'으로 옮긴다.
enum SampleWorkspace {
    /// 그 언어의 자료(W): 영어는 같은 회사·같은 흐름의 영어 벌, 그 밖은 한국어 벌.
    static func source(_ language: AppLanguage) -> String { language == .en ? SampleWorkspaceData.english : SampleWorkspaceData.json }

    static func load(now: Date = Date(), language: AppLanguage = .current) -> [String: Any] {
        guard let object = try? JSONSerialization.jsonObject(with: Data(source(language).utf8)) as? [String: Any] else { return [:] }
        let base = (object["baseTime"] as? String).flatMap(parse) ?? now
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        // 날짜만 적힌 값(사용량의 날짜 칸, 자료는 UTC 로 만든다)은 기준일에서 이 기기의 오늘까지 날 수만큼 옮긴다.
        var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        var local = Calendar(identifier: .gregorian); local.timeZone = .current
        let today = utc.date(from: local.dateComponents([.year, .month, .day], from: now)) ?? now
        let days = utc.dateComponents([.day], from: utc.startOfDay(for: base), to: today).day ?? 0
        var data = shift(object, by: now.timeIntervalSince(base), days: days, formatter: formatter, calendar: utc) as? [String: Any] ?? [:]
        if var usage = data["usage"] as? [String: [String: Any]] {
            for key in usage.keys { usage[key]?["timeZone"] = TimeZone.current.identifier }
            data["usage"] = usage
        }
        return data
    }

    /// 자료 속 시각·날짜 문자열을 모두 같은 만큼 옮긴다. 다른 글(제목·본문)은 그대로다.
    private static func shift(_ value: Any, by offset: TimeInterval, days: Int, formatter: ISO8601DateFormatter, calendar: Calendar) -> Any {
        switch value {
        case let object as [String: Any]: return object.mapValues { shift($0, by: offset, days: days, formatter: formatter, calendar: calendar) }
        case let array as [Any]: return array.map { shift($0, by: offset, days: days, formatter: formatter, calendar: calendar) }
        case let text as String where text.count == 24:
            guard text.wholeMatch(of: #/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/#) != nil, let date = formatter.date(from: text) else { return text }
            return formatter.string(from: date.addingTimeInterval(offset))
        case let text as String where text.count == 10:
            guard let match = text.wholeMatch(of: #/(\d{4})-(\d{2})-(\d{2})/#),
                  let day = calendar.date(from: DateComponents(year: Int(match.1), month: Int(match.2), day: Int(match.3))),
                  let moved = calendar.date(byAdding: .day, value: days, to: day) else { return text }
            let parts = calendar.dateComponents([.year, .month, .day], from: moved)
            return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        default: return value
        }
    }

    static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// 샘플의 첫 화면(본사 말고 첫 프로젝트)을 앱의 모델로 읽는다. 시험과 화면 견본이 쓴다.
    static func decoded(now: Date = Date(), language: AppLanguage = .current) throws -> (Bootstrap, ProjectState) {
        let data = load(now: now, language: language)
        let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: JSONSerialization.data(withJSONObject: data["bootstrap"] ?? [:]))
        let projects = data["projects"] as? [String: [String: Any]] ?? [:]
        guard let main = bootstrap.projects.first(where: { !$0.isHq }), var state = projects[main.id]?["state"] as? [String: Any] else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "샘플 자료에 프로젝트가 없습니다"))
        }
        state["messages"] = projects[main.id]?["messages"] ?? state["messages"]
        return (bootstrap, try JSONDecoder().decode(ProjectState.self, from: JSONSerialization.data(withJSONObject: state)))
    }
}

/// 열려 있는 샘플 서버들. URLProtocol 은 클래스로 등록되므로 요청의 머리글로 어느 서버인지 찾는다.
private final class SampleServerRegistry: @unchecked Sendable {
    static let shared = SampleServerRegistry()
    private let lock = NSLock()
    private var servers: [String: WeakSampleServer] = [:]
    private struct WeakSampleServer { weak var value: SampleServer? }
    func add(_ server: SampleServer) { lock.withLock { servers[server.id] = WeakSampleServer(value: server) } }
    func remove(_ id: String) { lock.withLock { _ = servers.removeValue(forKey: id) } }
    func get(_ id: String) -> SampleServer? { lock.withLock { servers[id]?.value } }
}

/// 샘플 세션의 유일한 프로토콜. 이 세션의 모든 요청을 받는다(그래야 실제 HTTP 로 넘어가지 않는다). 샘플 서버가 없거나 주소가 다르면 실패시킨다.
final class SampleURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canInit(with task: URLSessionTask) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let id = request.value(forHTTPHeaderField: SampleServer.headerName), let server = SampleServerRegistry.shared.get(id),
              let url = request.url, url.host == SampleServer.host else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let reply = server.reply(to: request, body: Self.body(of: request))
        guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if request.httpMethod != "HEAD" { client?.urlProtocol(self, didLoad: reply.body) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    /// URLSession 은 본문을 httpBody 대신 스트림으로 넘기기도 한다(올리기 포함).
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// 실시간 연결의 샘플 판. 소켓을 열지 않는다. 주소가 샘플 서버가 아니면 거절한다.
private struct SampleRealtimeFactory: RealtimeTransportFactory {
    let server: SampleServer
    func connect(request: URLRequest) async throws -> any RealtimeTransport {
        guard let url = request.url, url.scheme == "wss", url.host == SampleServer.host, url.port == nil, url.path == "/ws",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer \(SampleServer.accessCode)" else { throw URLError(.unsupportedURL) }
        return server.openSocket()
    }
}

/// 샘플 서버가 넣는 프레임을 차례대로 내준다. 넣기는 서버의 잠금 안에서 하므로 순번이 뒤집히지 않는다.
final class SampleRealtimeTransport: RealtimeTransport, @unchecked Sendable {
    let id = UUID()
    private let lock = NSLock()
    private var frames: [Data] = []
    private var waiter: (id: UUID, continuation: CheckedContinuation<Data, any Error>)?
    private var closed = false
    var onClose: (@Sendable () -> Void)?
    var pulse: Task<Void, Never>?

    func enqueue(_ frame: Data) {
        let resume: CheckedContinuation<Data, any Error>? = lock.withLock {
            guard !closed else { return nil }
            if let waiter { self.waiter = nil; return waiter.continuation }
            frames.append(frame)
            return nil
        }
        resume?.resume(returning: frame)
    }

    func receive() async throws -> Data {
        try Task.checkCancellation()
        let ticket = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
                let ready: Result<Data, any Error>? = lock.withLock {
                    if closed || Task.isCancelled { return .failure(URLError(.cancelled)) }
                    if !frames.isEmpty { return .success(frames.removeFirst()) }
                    if waiter != nil { return .failure(URLError(.cannotLoadFromNetwork)) }
                    waiter = (ticket, continuation)
                    return nil
                }
                if let ready { continuation.resume(with: ready) }
            }
        } onCancel: { [self] in
            let pending: CheckedContinuation<Data, any Error>? = lock.withLock {
                guard waiter?.id == ticket else { return nil }
                defer { waiter = nil }
                return waiter?.continuation
            }
            pending?.resume(throwing: CancellationError())
        }
    }

    func close() async { finish() }

    func finish() {
        let pending: CheckedContinuation<Data, any Error>? = lock.withLock {
            guard !closed else { return nil }
            closed = true
            frames.removeAll()
            defer { waiter = nil }
            return waiter?.continuation
        }
        pending?.resume(throwing: URLError(.cancelled))
        pulse?.cancel()
        onClose?()
    }
}
