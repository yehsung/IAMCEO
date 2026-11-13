import Foundation
import XCTest
@testable import IAMCEO

/// 받기 진행률을 모은다(다른 줄에서 불린다).
private final class LockedValues: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double?] = []
    func append(_ value: Double?) { lock.withLock { values.append(value) } }
    var last: Double? { lock.withLock { values.last ?? nil } }
}

/// F8: 샘플 모드는 기기 안의 가짜 서버(SampleServer)에 실제 연결과 같은 길로 붙는다.
/// 1) 서버 시험이 만든 실제 서버 응답을 앱의 해석기로 읽고, 2) 보내기·결재·할 일·자료 열기가 메모리에서 되며,
/// 3) 어떤 요청도 샘플 서버 밖(실제 망, 넘겨받은 세션, 이 기기의 저장소)으로 나가지 않는다.
@MainActor
final class SampleServerTests: XCTestCase {
    private func sample(_ configure: (SampleServer) -> Void = { _ in }) async throws -> AppStore {
        let store = AppStore(demo: true)
        if let server = store.sampleServer {
            server.deliveryDelay = .milliseconds(30); server.replyDelay = .milliseconds(60)
            configure(server)
        }
        try await waitWhile({ !(store.connectionStatus == .connected && store.state != nil && store.canWrite) }, timeout: .seconds(15))
        return store
    }

    // MARK: 실제 연결과 같은 길

    func testSampleConnectsLikeARealServerAndOpensTheFirstProject() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        XCTAssertTrue(store.isDemo)
        XCTAssertNotNil(store.api)
        XCTAssertEqual(store.endpoint, SampleServer.endpoint)
        XCTAssertEqual(store.selectedProjectID, "sample-pay")
        XCTAssertEqual(store.projects.map(\.id), ["hq", "sample-pay", "sample-ir"])
        XCTAssertEqual(store.members.count, 9)
        XCTAssertEqual(store.decisions.filter { $0.status == "open" }.count, 2)
        XCTAssertEqual(store.files.count, 5)
        XCTAssertNil(store.writeBlockedReason)
        XCTAssertTrue(store.uiCanWrite)
        XCTAssertFalse(store.needsPermissionChoice)
        // 실시간 연결도 샘플 서버의 규약(hello·ping)으로 붙는다. '실시간이 끊겼다'는 줄이 뜨지 않는다.
        try await waitWhile({ store.realtimeStatus != .live })
        // 모델 목록과 진단도 서버 응답으로 읽는다.
        try await waitWhile({ store.sampleServer?.requests.contains { $0.url?.path == "/api/models" } != true })
        XCTAssertNotNil(store.runtime)
    }

    func testSampleProjectsCanBeSwitched() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        await store.selectProject(id: "sample-ir")
        try await waitWhile({ store.state?.project.id != "sample-ir" || !store.canWrite })
        XCTAssertEqual(store.members.count, 3)
        await store.selectProject(id: "hq")
        try await waitWhile({ store.state?.project.id != "hq" })
        XCTAssertEqual(store.members.map(\.name), ["본사 총괄"])
    }

    // MARK: 쓰기는 기기 안에서

    func testSendingReachesTheMemberAndTheMemberAnswers() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let before = store.messages.count
        let sent = await store.sendMessage(text: "실패 화면에 고객센터 번호를 넣어 주세요", targetMemberID: "m-copy")
        XCTAssertTrue(sent)
        XCTAssertNil(store.messageSendNotice(targetMemberID: "m-copy"))
        try await waitWhile({ store.messages.first { $0.mine && $0.body.hasPrefix("실패 화면에 고객센터") }?.delivery != "delivered" })
        // 받은 팀장이 받았다고 답하고 일을 시작한다.
        try await waitWhile({ !store.messages.contains { $0.memberId == "m-copy" && $0.title == "지시를 받았습니다" } })
        XCTAssertEqual(store.messages.count, before + 2)
        XCTAssertEqual(store.members.first { $0.id == "m-copy" }?.status, "working")
        // 대화 기록(페이지)에도 같은 글이 있다.
        let owner = await store.activateHistory(targetMemberID: "m-copy")
        defer { store.deactivateHistory(ownerID: owner) }
        try await waitWhile({ !store.historyMessages.contains { $0.body.hasPrefix("실패 화면에 고객센터") } })
        XCTAssertTrue(store.historyMessages.allSatisfy { $0.memberId == "m-copy" || $0.targetMemberId == "m-copy" })
    }

    func testAnsweringADecisionMovesItToDone() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let decision = try XCTUnwrap(store.decisions.first { $0.id == "d-pg" })
        let answered = await store.answerDecision(decision, choice: "a", note: "이틀 빠른 쪽으로 갑니다")
        XCTAssertTrue(answered)
        try await waitWhile({ store.decisions.first { $0.id == "d-pg" }?.status != "delivered" })
        XCTAssertEqual(store.decisions.first { $0.id == "d-pg" }?.choice, "a")
        XCTAssertEqual(store.decisions.filter { $0.status == "open" }.count, 1)
        XCTAssertEqual(store.projects.first { $0.id == "sample-pay" }?.decisionCount, 1)
        XCTAssertNil(store.errorMessage)
    }

    func testTodosSettingsAndMemberModelChangeInMemory() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let todo = try XCTUnwrap(store.todos.first { $0.id == "t-key" })
        let done = await store.setTodoDone(todo, done: true)
        XCTAssertTrue(done)
        XCTAssertEqual(store.todos.first { $0.id == "t-key" }?.done, true)
        try await waitWhile({ store.todos.first { $0.id == "t-logo" }.map { store.reviewedTodo($0) } != true })
        let logo = try XCTUnwrap(store.todos.first { $0.id == "t-logo" })
        let dropped = await store.dropTodo(logo, reason: "로고는 이미 있습니다")
        XCTAssertTrue(dropped)
        XCTAssertEqual(store.todos.first { $0.id == "t-logo" }?.outcome, "dropped")

        var settings = try XCTUnwrap(store.bootstrap?.settings)
        settings.maxConcurrentTurns = 3
        let saved = await store.updateSettings(settings)
        XCTAssertTrue(saved)
        XCTAssertEqual(store.bootstrap?.settings.maxConcurrentTurns, 3)

        let member = try XCTUnwrap(store.members.first { $0.id == "m-research" })
        let changed = await store.patchMember(member, provider: "claude", model: "opus", effort: nil)
        XCTAssertTrue(changed)
        XCTAssertEqual(store.members.first { $0.id == "m-research" }?.modelOverride, "opus")
        XCTAssertNil(store.errorMessage)
    }

    func testMemberActionsAndCompactionFinish() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let mail = try XCTUnwrap(store.members.first { $0.id == "m-mail" })
        let slept = await store.sleepMember(mail)
        XCTAssertTrue(slept)
        XCTAssertEqual(store.members.first { $0.id == "m-mail" }?.status, "asleep")
        let card = try XCTUnwrap(store.members.first { $0.id == "m-card" })
        let compacted = await store.compactMember(card)
        XCTAssertTrue(compacted)
        try await waitWhile({ store.contextChecking.contains("m-card") || store.members.first { $0.id == "m-card" }?.contextPct != 6 })
        XCTAssertNil(store.errorMessage)
    }

    // MARK: 자료 열기

    func testFilesOpenFromTheSampleServer() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let api = try XCTUnwrap(store.api)
        let fee = try await store.fileBody(id: "f-fee")
        XCTAssertTrue(fee.body.contains("수수료"))
        let html = try await api.artifact(fileID: "f-copy")
        XCTAssertTrue(html.contains("완료·실패 화면 시안"))
        // 화면이 실제로 쓰는 길(render=1 + 격리 정책 머리글). 4차 리뷰 data-3: 예전에는 늘 '안전하게 열 수 없습니다'였다.
        let page = try await FileResources.artifact("f-copy", api: api)
        XCTAssertTrue(page.contains("완료·실패 화면 시안"))
        XCTAssertTrue(page.contains("Content-Security-Policy"), "실제 서버가 감싼 문서 그대로")
        let shot = try XCTUnwrap(store.files.first { $0.id == "f-shot" }?.attachments.first)
        let bytes = try await api.attachmentData(shot)
        XCTAssertEqual(Array(bytes.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        XCTAssertEqual(bytes.count, shot.size)
        let found = try await api.searchFilesWithFallback(projectID: "sample-pay", query: "이탈", files: store.files)
        XCTAssertEqual(found.first?.id, "f-funnel")
    }

    func testUploadsGoToTheSampleServerAndCanBeSent() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let api = try XCTUnwrap(store.api)
        let uploaded = try await api.upload(data: Data("로고".utf8), filename: "logo.txt", mime: "text/plain", projectID: "sample-pay")
        XCTAssertEqual(uploaded.name, "logo.txt")
        let round = try await api.attachmentData(uploaded)
        XCTAssertEqual(String(decoding: round, as: UTF8.self), "로고")
        // 화면의 첨부 올리기도 샘플 서버로만 간다.
        XCTAssertEqual(store.composerUploads.sessionConfiguration?.protocolClasses?.first.map(ObjectIdentifier.init), ObjectIdentifier(SampleURLProtocol.self))
    }

    /// 4차 리뷰 ui-2: iPhone 사진('사진-…')처럼 한글·띄어쓰기가 든 이름도 올린 뒤 다시 받을 수 있다.
    func testKoreanAndSpacedFileNamesRoundTrip() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let api = try XCTUnwrap(store.api)
        for name in ["사진-20260105-090000-1.jpg", "결제 화면 메모.txt", "100% 확인.txt"] {
            let uploaded = try await api.upload(data: Data(name.utf8), filename: name, mime: "text/plain", projectID: "sample-pay")
            XCTAssertEqual(uploaded.name, name)
            let round = try await api.attachmentData(uploaded)
            XCTAssertEqual(String(decoding: round, as: UTF8.self), name, name)
        }
    }

    /// 4차 리뷰 data-2: 진행률을 보이는 받기(PDF·영상 미리보기, 저장, 공유)도 샘플 서버 안에서 끝난다.
    func testProgressDownloadsStayInsideTheSampleServer() async throws {
        let network = try IsolatedTestNetwork { _ in XCTFail("샘플이 넘겨받은 세션으로 요청했습니다"); throw URLError(.badURL) }
        let store = AppStore(demo: true, session: network.session, persistCredentials: false)
        defer { store.prepareForReplacement() }
        let server = try XCTUnwrap(store.sampleServer)
        try await waitWhile({ !(store.connectionStatus == .connected && store.canWrite) }, timeout: .seconds(15))
        let api = try XCTUnwrap(store.api)
        let uploaded = try await api.upload(data: Data(repeating: 7, count: 4096), filename: "결제 흐름.pdf", mime: "application/pdf", projectID: "sample-pay")
        let fractions = LockedValues()
        let resource = try await FileResources.attachment(uploaded, api: api, progress: { fractions.append($0) })
        XCTAssertEqual(try resource.read(), Data(repeating: 7, count: 4096))
        XCTAssertEqual(fractions.last, 1)
        XCTAssertTrue(server.requests.contains { $0.url?.path == "/files/\(uploaded.id)/결제 흐름.pdf" }, "샘플 서버가 받았다")
        XCTAssertTrue(server.requests.allSatisfy { $0.url?.host == SampleServer.host })
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    /// 4차 리뷰 ui-1: 결재됨의 '다시 열기'가 샘플에서도 된다. 실제 서버처럼 AI 가 닫은 결재만 연다.
    func testReopeningAClosedDecisionInTheSample() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let closed = try XCTUnwrap(store.decisions.first { $0.id == "d-old" })
        let reopened = await store.reopenDecision(closed)
        XCTAssertTrue(reopened)
        try await waitWhile({ store.decisions.first { $0.id == "d-old" }?.status != "open" })
        let decision = try XCTUnwrap(store.decisions.first { $0.id == "d-old" })
        XCTAssertNil(decision.closeKind)
        XCTAssertEqual(decision.reopenNote, "자료 조사가 닫았던 결재를 대표가 다시 열었습니다(닫은 이유: 대화에서 국내 결제만 한다고 정했습니다.)")
        XCTAssertNil(store.errorMessage)
        // 이미 열린 결재는 다시 열지 않는다(실제 서버의 409 와 같은 코드).
        let api = try XCTUnwrap(store.api)
        do {
            let _: Decision = try await api.request("/api/decisions/d-old/reopen", method: "POST")
            XCTFail("열린 결재는 다시 열지 않는다")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 409)
            XCTAssertEqual(error.code, "decision_reopen_refused")
        }
    }

    /// 4차 리뷰 lang-7·ui-8: 샘플의 오류는 실제 서버처럼 코드와 대표 문장을 싣고(영어 화면이 영어로 고른다),
    /// 샘플 서버는 늘 이 앱과 같은 단계라 '서버가 옛 버전' 줄이 뜨지 않는다.
    func testSampleErrorsAndVersionLookLikeARealServer() async throws {
        let store = try await sample()
        defer { store.prepareForReplacement() }
        let api = try XCTUnwrap(store.api)
        do {
            let _: Decision = try await api.request("/api/decisions/none")
            XCTFail("없는 결재")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "decision_not_found")
            AppLanguage.withOverride(.en) { XCTAssertEqual(error.localizedDescription, "Decision not found") }
        }
        let bootstrap = try XCTUnwrap(store.bootstrap)
        XCTAssertEqual(bootstrap.server?.apiLevel, AppVersion.apiLevel)
        XCTAssertNil(CompatNotice(bootstrap, onThisMac: false))
        var later = bootstrap; later.server?.apiLevel = AppVersion.apiLevel + 1
        XCTAssertNil(CompatNotice(later, onThisMac: false, appLevel: AppVersion.apiLevel + 1), "server 칸이 있으면 단계만으로 알리지 않는다")
    }

    // MARK: 바깥으로 나가지 않는다

    func testEveryRequestStaysInsideTheSampleServer() async throws {
        let network = try IsolatedTestNetwork { _ in XCTFail("샘플이 넘겨받은 세션으로 요청했습니다"); throw URLError(.badURL) }
        let savedEndpoint = UserDefaults.standard.string(forKey: "iamceo.endpoint")
        // 넘겨받은 세션·실시간 연결이 있어도 샘플은 쓰지 않는다.
        let store = AppStore(demo: true, session: network.session, persistCredentials: true,
                             realtime: RealtimeClient(factory: network.webSockets))
        defer { store.prepareForReplacement() }
        let server = try XCTUnwrap(store.sampleServer)
        server.deliveryDelay = .milliseconds(20); server.replyDelay = .milliseconds(40)
        try await waitWhile({ !(store.connectionStatus == .connected && store.canWrite) }, timeout: .seconds(15))
        _ = await store.sendMessage(text: "확인", targetMemberID: nil)
        let decision = try XCTUnwrap(store.decisions.first { $0.status == "open" })
        _ = await store.answerDecision(decision, choice: decision.rec, note: nil)
        _ = try await store.fileBody(id: "f-config")
        await store.refresh()

        XCTAssertTrue(network.requests.isEmpty)
        let sockets = await network.webSockets.requests
        XCTAssertTrue(sockets.isEmpty)
        XCTAssertFalse(server.requests.isEmpty)
        XCTAssertTrue(server.requests.allSatisfy { $0.url?.host == SampleServer.host && $0.url?.scheme == "https" })
        // 이 기기에 아무것도 남기지 않는다(접속 코드·주소·화면 위치·쓰기 기록·초안).
        XCTAssertEqual(UserDefaults.standard.string(forKey: "iamceo.endpoint"), savedEndpoint)
        let fields = Dictionary(uniqueKeysWithValues: Mirror(reflecting: store).children.compactMap { child in child.label.map { ($0, child.value) } })
        XCTAssertEqual(fields["persistCredentials"] as? Bool, false)
        for field in ["pathMonitor", "pushNotifications", "navigationDefaults"] {
            let value = try XCTUnwrap(fields[field], field)
            XCTAssertTrue(Mirror(reflecting: value).children.isEmpty, field)
        }
        for (owner, label) in [(store as Any, "writeStorage"), (store.drafts as Any, "storage")] {
            let storage = try XCTUnwrap(Mirror(reflecting: owner).children.first { $0.label == label }?.value as? LocalStateStorage, label)
            XCTAssertFalse(storage.enabled, label)
        }
        await network.close()
    }

    func testSampleSessionRefusesEveryOtherAddress() async throws {
        let server = SampleServer()
        defer { server.shutdown() }
        // 이 세션의 유일한 프로토콜이 모든 요청을 받는다. 실제 HTTP 로 넘어갈 길이 없다.
        XCTAssertEqual(server.configuration.protocolClasses?.count, 1)
        XCTAssertTrue(SampleURLProtocol.canInit(with: URLRequest(url: URL(string: "https://example.com/")!)))
        for address in ["https://example.com/api/bootstrap", "http://127.0.0.1:7878/api/bootstrap", "https://sample.iamceo.invalid:8443/api/bootstrap"] {
            var request = URLRequest(url: URL(string: address)!)
            request.setValue("Bearer \(SampleServer.accessCode)", forHTTPHeaderField: "Authorization")
            do {
                let (_, response) = try await server.session.data(for: request)
                XCTAssertNotEqual((response as? HTTPURLResponse)?.statusCode, 200, address)
            } catch let error as URLError { XCTAssertEqual(error.code, .unsupportedURL, address) }
        }
        // 샘플 접속 코드 없이는 답하지 않는다.
        let (_, unauthorized) = try await server.session.data(from: URL(string: SampleServer.endpoint + "/api/bootstrap")!)
        XCTAssertEqual((unauthorized as? HTTPURLResponse)?.statusCode, 401)
        // 실시간 연결도 샘플 주소가 아니면 열지 않는다(소켓을 만들지 않는다).
        for address in ["wss://example.com/ws", "ws://127.0.0.1:7878/ws"] {
            var request = URLRequest(url: URL(string: address)!)
            request.setValue("Bearer \(SampleServer.accessCode)", forHTTPHeaderField: "Authorization")
            do { _ = try await server.realtimeFactory.connect(request: request); XCTFail(address) } catch {}
        }
    }

    // MARK: 자료가 낡지 않았다

    func testFixtureIsServerJSONThatTheAppDecodes() async throws {
        let server = SampleServer()
        defer { server.shutdown() }
        let api = APIClient(endpoint: try ServerEndpoint(SampleServer.endpoint), accessCode: SampleServer.accessCode, session: server.session, liteStateEnabled: true)
        let bootstrap: Bootstrap = try await api.request("/api/bootstrap")
        XCTAssertEqual(bootstrap.projects.count, 3)
        XCTAssertNil(bootstrap.tailnet)
        _ = try await api.capabilities()
        _ = try await api.models()
        let _: RuntimeDiagnostics = try await api.request("/api/runtime")
        for project in bootstrap.projects {
            let sync = try await api.sync(projectID: project.id)
            XCTAssertEqual(sync.projectStatus, .ok)
            let state: ProjectState = try await api.request("/api/projects/\(project.id)/state")
            XCTAssertEqual(state.project.id, project.id)
            let page = try await api.messagePage(projectID: project.id, scope: .project, cursor: nil, limit: 200)
            XCTAssertFalse(page.hasOlder)
            _ = try await api.unassignedDeliveryNotices(projectID: project.id)
            for member in state.members {
                _ = try await api.activity(memberID: member.id)
                _ = try await api.deliveryNotices(memberID: member.id, before: nil, limit: 20)
                _ = try await api.messagePage(projectID: project.id, scope: .member(memberId: member.id), cursor: nil, limit: 200)
            }
            for file in state.files { _ = try await api.fileBody(id: file.id) }
            for decision in state.decisions {
                let one: Decision = try await api.request("/api/decisions/\(decision.id)")
                XCTAssertEqual(one.id, decision.id)
            }
        }
        _ = try await api.archivedProjects()
        // T(F6): 사용량 보고도 서버 응답 그대로이고, 날짜는 이 기기의 오늘로 옮겨져 있다.
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let today = calendar.dateComponents([.year, .month, .day], from: Date())
        let todayText = String(format: "%04d-%02d-%02d", today.year ?? 0, today.month ?? 0, today.day ?? 0)
        for days in [1, 7, 30] {
            let report: UsageReport = try await api.request("/api/usage?days=\(days)")
            XCTAssertEqual(report.days, days)
            XCTAssertEqual(report.to, todayText)
            XCTAssertFalse(report.members.isEmpty)
            XCTAssertNotNil(report.totals.costUsd)
            XCTAssertTrue(report.daily.allSatisfy { $0.day >= report.from && $0.day <= report.to })
        }
    }

    func testDatesInTheFixtureMoveToToday() throws {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let data = SampleWorkspace.load(now: now)
        let usage = try XCTUnwrap((data["usage"] as? [String: [String: Any]])?["7"])
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let today = calendar.dateComponents([.year, .month, .day], from: now)
        XCTAssertEqual(usage["to"] as? String, String(format: "%04d-%02d-%02d", today.year ?? 0, today.month ?? 0, today.day ?? 0))
        XCTAssertEqual(usage["timeZone"] as? String, TimeZone.current.identifier)
        // 본문 속 숫자나 날짜처럼 보이지 않는 글은 바꾸지 않는다.
        let files = try XCTUnwrap(data["files"] as? [String: [String: Any]])
        XCTAssertTrue((files["f-funnel"]?["body"] as? String)?.contains("장바구니,12840,18%") == true)
    }

    func testFixtureLooksLikeAHealthyTeamMovedToNow() throws {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let (_, state) = DemoFixtures.workspace(now: now)
        // 가장 최근 글은 1분 전, 첫 계획은 40분 전.
        let parse = { (text: String) in try XCTUnwrap(SampleWorkspace.parse(text)) }
        XCTAssertEqual(try parse(try XCTUnwrap(state.messages.first { $0.id == "x10" }).at).timeIntervalSince(now), -60, accuracy: 0.5)
        XCTAssertEqual(try parse(try XCTUnwrap(state.messages.first { $0.id == "x1" }).at).timeIntervalSince(now), -40 * 60, accuracy: 0.5)
        // 일하는 중·내 답 기다림·쉬는 중·잠듦이 섞여 있고, 오류·막힘·확인 필요가 없다.
        XCTAssertEqual(Set(state.members.map(\.status)), ["working", "waiting", "idle", "asleep"])
        XCTAssertTrue(state.members.allSatisfy { $0.lastError == nil && $0.blockedReason == nil && !MemberStatusInfo.isUncertain($0) })
        XCTAssertTrue(state.messages.filter(\.mine).allSatisfy { $0.delivery == "delivered" })
        XCTAssertEqual(state.deliveryNotices?.members.map(\.needsOwnerCount).reduce(0, +), 0)
        XCTAssertTrue(state.members.filter { $0.contextPct != nil }.allSatisfy { $0.contextState?.measurement?.quality == "exact" })
    }
}

private extension AppStore {
    /// 시험용: 그 할 일의 쓰기 기준(검토 버전)을 받았는가.
    func reviewedTodo(_ todo: Todo) -> Bool { writeRevisions?.todos?[todo.id] != nil && !pendingActions.contains("todo:\(todo.id)") }
}
