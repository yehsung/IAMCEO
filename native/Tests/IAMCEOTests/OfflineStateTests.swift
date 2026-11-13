import Foundation
import os
import XCTest
@testable import IAMCEO

/// 시험 서버 앞에 두는 스위치: 끊김, 접속 코드 거절, 글 거절.
private final class OfflineSwitches: @unchecked Sendable {
    private let lock = NSLock()
    private var _down = false, _unauthorized = false, _refuseMessages = false
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var unauthorized: Bool { get { lock.withLock { _unauthorized } } set { lock.withLock { _unauthorized = newValue } } }
    var refuseMessages: Bool { get { lock.withLock { _refuseMessages } } set { lock.withLock { _refuseMessages = newValue } } }
}

/// F1(4차 S): 마지막으로 본 상태와 연결되면 보낼 글.
@MainActor final class OfflineStateTests: XCTestCase {
    private let leadKey = DraftStore.key(project: "p", target: nil)
    private let memberKey = DraftStore.key(project: "p", target: "m")

    private func folder() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("offline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func network(_ server: WriteTestServer, _ switches: OfflineSwitches) throws -> IsolatedTestNetwork {
        try IsolatedTestNetwork { request in
            if switches.down { throw URLError(.cannotConnectToHost) }
            if switches.unauthorized { return IsolatedTestHTTPReply(status: 401) }
            if switches.refuseMessages, request.url?.path == "/api/projects/p/messages" {
                return IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"받는 사람이 없습니다"}"#.utf8))
            }
            return try server.handle(request)
        }
    }

    private func store(_ network: IsolatedTestNetwork, offline: OfflineStateStore, drafts: DraftStore = DraftStore(persist: false),
                       submissions: SubmissionStore? = nil) throws -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts,
                             submissions: try submissions ?? SubmissionStore(persist: false), offline: offline)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        // 시험 서버는 127.0.0.1 이다. Mac 앱이 이 Mac 의 서버에 붙을 때의 예외(아래 시험)를 끄고 iPhone·원격처럼 다룬다.
        store.lastSeenOnThisMac = true
        return store
    }

    private func lastState() -> ProjectState {
        ProjectState(project: Project(id: "p"), members: [Member(id: "m", projectId: "p")],
                     decisions: [Decision(id: "d1", projectId: "p")],
                     messages: [Message(id: "old", projectId: "p", body: "지난 보고")])
    }

    private func seed(_ offline: OfflineStateStore, _ network: IsolatedTestNetwork, age: TimeInterval = 720,
                      serverID: String? = nil) async {
        await offline.saveLastSeen(LastSeenSnapshot(namespace: DraftStore.endpointNamespace(network.endpoint),
                                                    savedAt: Date(timeIntervalSinceNow: -age), serverID: serverID,
                                                    bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: lastState()))
    }

    private func permissions(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
    }

    // MARK: Last seen state

    func testLastSeenIsReadOnlyUntilTheServerAnswersAndUnreachableKeepsIt() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        let namespace = DraftStore.endpointNamespace(net.endpoint)
        XCTAssertEqual(store.lastSeen?.namespace, namespace)
        XCTAssertEqual(store.selectedProjectID, "p")
        XCTAssertEqual(store.historyMessages.map(\.id), ["old"])
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(store.writeBlockedReason, "마지막으로 본 상태라 지금은 바꿀 수 없습니다")
        XCTAssertEqual(store.drafts.namespace, namespace, "같은 서버의 초안을 그대로 쓴다")
        XCTAssertEqual(store.lastSeenAgeText, "12분 전")
        XCTAssertEqual(store.lastDataCheckAt, store.lastSeen?.savedAt, "설정 → 연결의 '마지막 데이터 확인'은 그 상태를 남긴 때(4차 리뷰 ui-5)")
        XCTAssertFalse(store.lastSeenAnnounced, "바로 붙는 연결에서 줄이 깜빡이지 않게 잠깐 기다린다")

        await store.connect()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertNotNil(store.lastSeen, "서버에 닿지 않으면 마지막 상태를 그대로 둔다")
        XCTAssertTrue(store.lastSeenAnnounced)
        XCTAssertNotNil(store.connectionIssue)
        XCTAssertNil(store.errorMessage, "까닭은 마지막 상태 줄이 말한다(빨간 오류 줄을 겹치지 않는다)")
        XCTAssertEqual(store.state?.messages.map(\.id), ["old"])
        XCTAssertEqual(store.drafts.namespace, namespace, "연결을 시도하는 동안에도 쓰던 초안 자리를 잃지 않는다")
        XCTAssertTrue(store.waitsForConnection)
        XCTAssertNotNil(offline.readLastSeen(namespace: namespace))

        switches.down = false
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertNil(store.lastSeen, "서버가 새 상태를 주면 표지를 내린다")
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(store.state?.messages, [], "화면은 서버의 지금 상태")
        store.disconnect()
        XCTAssertNil(offline.readLastSeen(namespace: namespace), "이 기기에서 나가면 지운다")
    }

    /// 4차 리뷰 ui-4: Tailscale 이 꺼진 동안의 자동 재시도는 까닭을 지우지 않는다(줄의 판·높이가 그대로).
    /// 대표가 '다시 연결'을 누른 시도만 '최신 상태를 받는 중'으로 보인다.
    func testAutomaticRetryKeepsTheLastSeenReasonSteady() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let gate = DispatchSemaphore(value: 0)
        let held = OSAllocatedUnfairLock(initialState: false)
        let entered = expectation(description: "재시도가 서버에 닿으려 했다")
        entered.assertForOverFulfill = false
        let net = try IsolatedTestNetwork { _ in
            if held.withLock({ $0 }) { entered.fulfill(); _ = gate.wait(timeout: .now() + 5) }
            throw URLError(.cannotConnectToHost)
        }
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        await store.connect()
        let reason = try XCTUnwrap(store.connectionIssue)
        held.withLock { $0 = true }
        let retry = Task { await store.connect() }
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(store.connectionStatus, .connecting)
        XCTAssertEqual(store.connectionIssue, reason, "자동 재시도 동안 까닭 줄을 지우지 않는다")
        held.withLock { $0 = false }
        for _ in 0..<4 { gate.signal() }
        await retry.value
        XCTAssertEqual(store.connectionStatus, .failed)
        await store.reconnectFromLastSeen()
        XCTAssertNotNil(store.connectionIssue, "누른 시도가 실패하면 다시 까닭을 보인다")
        XCTAssertNotNil(store.lastSeen)
    }

    /// 4차 확인 새 문제 3: 마지막 상태를 보는 채 다시 붙다가 서버가 답한 실패(접속 코드 거절·응답 오류)로 끝나면, 앞선 망 실패의
    /// 까닭을 남기지 않는다(Mac 사이드바의 '눌러서 다시 연결 · 까닭'이 옛 까닭을 보이지 않게).
    func testAnsweredFailureAfterAnUnreachableOneDropsTheOldReason() async throws {
        for answered in [401, 500] {
            let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
            let switches = OfflineSwitches(); switches.down = true
            let server = WriteTestServer()
            let net = try IsolatedTestNetwork { request in
                if switches.down { throw URLError(.cannotConnectToHost) }
                if switches.unauthorized { return IsolatedTestHTTPReply(status: answered, data: Data(#"{"error":"거절"}"#.utf8)) }
                return try server.handle(request)
            }
            let offline = OfflineStateStore(directory: root)
            await seed(offline, net)
            let store = try store(net, offline: offline)
            store.restoreLastSeen()
            await store.connect()
            XCTAssertNotNil(store.connectionIssue, "\(answered)")
            switches.down = false; switches.unauthorized = true
            await store.connect()
            XCTAssertEqual(store.connectionStatus, .failed, "\(answered)")
            XCTAssertNil(store.lastSeen, "\(answered)")
            XCTAssertNil(store.connectionIssue, "\(answered): 서버가 답한 실패가 옛 망 실패의 까닭을 대신한다")
            XCTAssertNotNil(store.errorMessage, "\(answered): 연결 화면이 지금 까닭을 보인다")
        }
    }

    func testSavesOnlyServerConfirmedStateAsProtectedFile() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), net = try network(server, OfflineSwitches())
        let offline = OfflineStateStore(directory: root)
        let store = try store(net, offline: offline)
        await store.saveLastSeenNow()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("last-seen.json").path),
                       "연결 전에는 남길 상태가 없다")
        await store.connect()
        await store.saveLastSeenNow()
        let namespace = DraftStore.endpointNamespace(net.endpoint)
        let saved = try XCTUnwrap(offline.readLastSeen(namespace: namespace))
        XCTAssertEqual(saved.state?.project.id, "p")
        XCTAssertEqual(saved.state?.members.map(\.id), ["m"])
        XCTAssertEqual(saved.savedAt.timeIntervalSince1970, try XCTUnwrap(store.lastSuccessfulSyncAt).timeIntervalSince1970, accuracy: 0.001,
                       "저장한 때가 아니라 서버가 확인해 준 때")
        XCTAssertNil(saved.bootstrap.runtime)
        XCTAssertNil(saved.bootstrap.apiOutage)
        XCTAssertEqual(try permissions(root.appendingPathComponent("last-seen.json")), 0o600)
        store.disconnect()
    }

    func testLastSeenBelongsToOneServerOnly() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let offline = OfflineStateStore(directory: root)
        await offline.saveLastSeen(LastSeenSnapshot(namespace: "http://100.64.0.1:7878", savedAt: Date(), serverID: nil,
                                                    bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: nil))
        XCTAssertNotNil(offline.readLastSeen(namespace: "http://100.64.0.1:7878"))
        XCTAssertNil(offline.readLastSeen(namespace: "http://100.64.0.2:7878"), "다른 서버에는 보이지 않는다")
        XCTAssertNil(offline.readLastSeen(namespace: "http://100.64.0.1:7878"), "다른 서버 것을 찾으면 남은 하나도 지운다")
        try Data("{".utf8).write(to: root.appendingPathComponent("last-seen.json"))
        XCTAssertNil(offline.readLastSeen(namespace: "http://100.64.0.1:7878"), "읽을 수 없는 파일은 버린다")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("last-seen.json").path))
        // 지운 뒤 늦게 끝난 저장은 파일을 되살리지 못한다.
        let late = LastSeenSnapshot(namespace: "n", savedAt: Date(), serverID: nil, bootstrap: Bootstrap(projects: []), state: nil)
        let gate = OfflineFileGate(), url = root.appendingPathComponent("gate.json")
        gate.remove(url, epoch: 2)
        XCTAssertFalse(gate.write(try JSONEncoder().encode(late), to: url, epoch: 1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(gate.write(try JSONEncoder().encode(late), to: url, epoch: 2))
    }

    func testMacAppOnItsOwnServerKeepsTheConnectionScreen() async throws {
        #if os(macOS)
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let net = try network(WriteTestServer(), OfflineSwitches())
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.lastSeenOnThisMac = false
        store.restoreLastSeen()
        XCTAssertNil(store.lastSeen, "이 Mac 의 서버가 꺼져 있으면 연결 화면의 '이 Mac에서 시작'이 답이다(가리지 않는다)")
        XCTAssertNil(store.bootstrap)
        await store.connect()
        await store.saveLastSeenNow()
        let saved = offline.readLastSeen(namespace: DraftStore.endpointNamespace(net.endpoint))
        XCTAssertNil(saved, "쓰지 않을 상태는 남기지도 않는다")
        store.disconnect()
        #endif
    }

    func testRefusedAccessCodeForgetsLastSeen() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(), net = try network(WriteTestServer(), switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        switches.unauthorized = true
        await store.connect()
        XCTAssertNil(store.lastSeen)
        XCTAssertNil(store.bootstrap, "연결 화면으로 돌아간다")
        XCTAssertEqual(store.drafts.namespace, "unassigned")
        XCTAssertNil(offline.readLastSeen(namespace: DraftStore.endpointNamespace(net.endpoint)))
    }

    func testAnsweredFailureLeavesForTheConnectionScreenButKeepsTheFile() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let net = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 500, data: Data(#"{"error":"boom"}"#.utf8)) }
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        await store.connect()
        XCTAssertNil(store.lastSeen)
        XCTAssertNil(store.bootstrap)
        XCTAssertNotNil(store.errorMessage, "연결 화면이 까닭을 보인다")
        XCTAssertNotNil(offline.readLastSeen(namespace: DraftStore.endpointNamespace(net.endpoint)))
    }

    func testConnectingToAnotherServerForgetsLastSeen() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(); switches.down = true
        let net = try network(WriteTestServer(), switches), other = try IsolatedTestNetwork()
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        XCTAssertNotNil(store.lastSeen)
        store.endpoint = other.endpoint.url.absoluteString
        await store.connect()
        XCTAssertNil(store.lastSeen)
        XCTAssertNil(store.bootstrap)
        XCTAssertNil(offline.readLastSeen(namespace: DraftStore.endpointNamespace(net.endpoint)))
    }

    /// 4차 리뷰 data-4: 상한은 서버마다 센다. V(0.2.5): 다른 서버에 연결해도 이전 서버에 보내려던 글은 지우지 않고(예전에는 지웠다)
    /// 보내지도 않는다. 대기열 화면에 '다른 서버에 보내려던 글'로 따로 보인다. 지금 붙은 서버의 글은 그대로 보낸다.
    func testConnectingToAnotherServerKeepsTheOldServersQueueUnsent() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let offline = OfflineStateStore(directory: root)
        let old = "http://100.64.0.9:7878", here = DraftStore.endpointNamespace(net.endpoint)
        for index in 0..<OfflineStateStore.itemLimit {
            _ = try offline.enqueue(namespace: old, projectID: "p", targetMemberID: nil, targetName: nil, text: "옛 서버에 갈 글 \(index)")
        }
        XCTAssertThrowsError(try offline.enqueue(namespace: old, projectID: "p", targetMemberID: nil, targetName: nil, text: "넘침"))
        try offline.pause(namespace: old, reason: "멈춤")
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "이 서버에 갈 글")
        let store = try store(net, offline: offline)
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(offline.items(namespace: old).count, OfflineStateStore.itemLimit, "다른 서버에 붙어도 옛 서버 몫은 말없이 지우지 않는다")
        XCTAssertEqual(store.otherServerQueuedMessages.count, OfflineStateStore.itemLimit, "대기열 화면에 따로 보인다")
        XCTAssertEqual(offline.pausedReason(namespace: old), "멈춤", "그 서버의 멈춤도 그대로 둔다")
        XCTAssertEqual(server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }, ["이 서버에 갈 글"])
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.count, OfflineStateStore.itemLimit, "기기의 파일에도 남는다")
        store.disconnect()
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.count, OfflineStateStore.itemLimit, "나가기는 이 서버의 글만 지운다")
    }

    /// 4차 확인 새 문제 2: 같은 서버를 다른 주소로 다시 붙으면(401 뒤 QR 다시 연결에서 *.ts.net 이름 대신 HTTPS 주소가 앞에 오는 등)
    /// 그 주소 몫의 글을 지우지 않고 이 주소 몫으로 옮겨 순서대로 보낸다. 같은 서버 = 같은 데이터 폴더(home) + 같은 기기
    /// (같은 호스트, 또는 서버가 알려 준 Tailscale 주소). 같은 Mac 의 다른 폴더(시험 서버)와 다른 서버 몫은 예전처럼 지운다.
    func testReconnectingToTheSameServerThroughAnotherAddressKeepsTheQueue() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let here = DraftStore.endpointNamespace(net.endpoint)
        let home = "/Users/owner/.iamceo"
        server.change { $0.bootstrap.home = home; $0.bootstrap.urls = ["http://127.0.0.1:7878", "http://100.64.0.9:7878"] }
        let owner = QueueOwner(home: home, addresses: ["http://127.0.0.1:7878", "http://100.64.0.9:7878"])
        // 같은 호스트의 다른 주소(이름 ↔ HTTPS 처럼 포트·http/https 만 다름)
        let sameHost = "https://127.0.0.1", tailnetIP = "http://100.64.0.9:7878"
        let testServer = "https://127.0.0.1:8443", otherServer = "http://100.64.0.10:7878"
        let offline = OfflineStateStore(directory: root)
        _ = try offline.enqueue(namespace: sameHost, projectID: "p", targetMemberID: nil, targetName: nil, text: "옛 주소로 둔 글 1", owner: owner)
        _ = try offline.enqueue(namespace: testServer, projectID: "p", targetMemberID: nil, targetName: nil, text: "시험 서버 글",
                                owner: QueueOwner(home: "/private/tmp/iamceo-test-home", addresses: []))
        _ = try offline.enqueue(namespace: tailnetIP, projectID: "p", targetMemberID: nil, targetName: nil, text: "옛 주소로 둔 글 2", owner: owner)
        _ = try offline.enqueue(namespace: otherServer, projectID: "p", targetMemberID: nil, targetName: nil, text: "다른 서버 글",
                                owner: QueueOwner(home: home, addresses: [otherServer]))
        _ = try offline.enqueue(namespace: sameHost, projectID: "p", targetMemberID: nil, targetName: nil, text: "옛 주소로 둔 글 3", owner: owner)
        let store = try store(net, offline: offline)
        await store.connect()
        try await waitWhile { server.read { $0.sentIDs.count } < 3 || store.outboxFlushing }
        XCTAssertEqual(server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } },
                       ["옛 주소로 둔 글 1", "옛 주소로 둔 글 2", "옛 주소로 둔 글 3"], "같은 서버의 다른 주소 몫은 지우지 않고 쓴 순서대로 보낸다")
        XCTAssertTrue(offline.items(namespace: sameHost).isEmpty)
        XCTAssertTrue(offline.items(namespace: tailnetIP).isEmpty)
        // V: 다른 서버 몫은 예전처럼 지우지 않고 보내지도 않는다(대기열 화면에 따로 보인다).
        XCTAssertEqual(offline.items(namespace: testServer).map(\.text), ["시험 서버 글"], "같은 Mac 이어도 데이터 폴더가 다른 서버(시험 서버)는 다른 서버")
        XCTAssertEqual(offline.items(namespace: otherServer).map(\.text), ["다른 서버 글"], "자기 주소로 알려 주지 않은 서버는 다른 서버")
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["시험 서버 글", "다른 서버 글"])
        XCTAssertNil(store.outboxPausedReason)
        XCTAssertEqual(Set((OfflineStateStore(directory: root).outbox.owners ?? [:]).keys), [testServer, otherServer],
                       "글이 남지 않은 주소의 표지는 남기지 않는다")
        store.disconnect()
    }

    /// 옛 주소로 보낸 글의 결과를 모르는 채 주소가 바뀌었으면, 옮긴 글은 멈춰 두고 대표가 확인한 뒤 이어서 보낸다
    /// (그 결과는 옛 주소의 전송 기록이 맡아 새 주소로는 확인할 수 없다. 순서를 지킨다).
    func testMovedQueueWaitsForTheOwnerWhenAnEarlierResultIsUnknown() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let home = "/Users/owner/.iamceo", before = "https://127.0.0.1"
        server.change { $0.bootstrap.home = home }
        let owner = QueueOwner(home: home, addresses: [])
        let offline = OfflineStateStore(directory: root)
        let left = try offline.enqueue(namespace: before, projectID: "p", targetMemberID: nil, targetName: nil, text: "결과를 모르는 글", owner: owner)
        try offline.markSent(id: left.id, attemptID: "attempt-before")
        _ = try offline.enqueue(namespace: before, projectID: "p", targetMemberID: nil, targetName: nil, text: "다음 글", owner: owner)
        let store = try store(net, offline: offline)
        await store.connect()
        await store.refresh()
        XCTAssertEqual(store.queuedMessages.map(\.text), ["다음 글"])
        XCTAssertEqual(store.outboxPausedReason, "앞서 보낸 글의 접수를 확인하기 전에 서버 주소가 바뀌었습니다. 대화에서 그 글이 들어갔는지 확인한 뒤 이어서 보내 주세요.")
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "멈춘 동안에는 보내지 않는다")
        XCTAssertTrue(offline.sent(namespace: before).isEmpty)
        XCTAssertEqual(offline.owner(namespace: store.writeNamespace)?.home, home, "옮긴 글은 지금 서버의 표지를 단다(다음에 또 주소가 바뀌어도 옮긴다)")
        store.resumeOutbox()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }, ["다음 글"])
        store.disconnect()
    }

    /// 입력칸에서 넣은 글은 그때 보던 서버의 표지(데이터 폴더·자기 주소)를 함께 남긴다.
    func testQueuedMessagesRememberWhichServerTheyAreFor() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(); switches.down = true
        let net = try network(WriteTestServer(), switches)
        let offline = OfflineStateStore(directory: root)
        await offline.saveLastSeen(LastSeenSnapshot(namespace: DraftStore.endpointNamespace(net.endpoint), savedAt: Date(timeIntervalSinceNow: -60),
                                                    serverID: nil,
                                                    bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")], home: "/Users/owner/.iamceo",
                                                                         urls: ["http://100.64.0.9:7878"]),
                                                    state: lastState()))
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        drafts.setText("연결되면 보낼 글", for: leadKey)
        XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        XCTAssertEqual(OfflineStateStore(directory: root).owner(namespace: store.writeNamespace),
                       QueueOwner(home: "/Users/owner/.iamceo", addresses: ["http://100.64.0.9:7878"]))
    }

    /// 같은 서버 판정: 같은 데이터 폴더 + 같은 기기(같은 호스트, 또는 서버가 알려 준 Tailscale 주소. 포트까지).
    func testSameServerIsJudgedByTheFolderAndTheAddressesTheServerReports() {
        let home = "/Users/owner/.iamceo"
        let name = "http://office-mac.tail1234.ts.net:7878", https = "https://office-mac.tail1234.ts.net", ip = "http://100.64.0.9:7878"
        let owner = QueueOwner(home: home, addresses: ["http://127.0.0.1:7878", ip])
        let server = Bootstrap(home: home, urls: ["http://127.0.0.1:7878", ip])
        func same(_ old: String, _ current: String, owner: QueueOwner? = owner, server: Bootstrap = server) -> Bool {
            AppStore.sameServer(old, owner: owner, as: current, server: server)
        }
        XCTAssertTrue(same(name, "http://office-mac.tail1234.ts.net:7878/", owner: nil), "같은 주소(끝의 / 만 다름)는 표지가 없어도 같다")
        XCTAssertTrue(same(name, https), "iPhone 의 흔한 경우: 이름 주소 → HTTPS 주소(같은 호스트)")
        XCTAssertTrue(same(https, name), "HTTPS 를 끈 뒤 이름 주소로")
        XCTAssertTrue(same(ip, https), "지금 서버가 옛 주소(100.x)를 자기 주소로 알려 준다")
        XCTAssertTrue(same(https, ip), "옛 서버가 지금 주소(100.x)를 자기 주소로 알려 주었다")
        XCTAssertFalse(same(name, https, owner: QueueOwner(home: "/private/tmp/test-home", addresses: [])), "같은 Mac 의 다른 폴더(시험 서버)는 다른 서버")
        XCTAssertFalse(same(name, name, owner: QueueOwner(home: "/private/tmp/test-home", addresses: [])),
                       "V: 같은 주소라도 두 데이터 폴더를 다 알고 서로 다르면 다른 서버")
        XCTAssertTrue(same(name, name, owner: QueueOwner(home: "", addresses: [])), "폴더를 모르면 같은 주소는 예전처럼 같은 서버")
        XCTAssertFalse(same(name, https, owner: nil), "표지가 없는 글은 예전처럼 다른 서버로 본다")
        XCTAssertFalse(same(name, https, owner: QueueOwner(home: "", addresses: []), server: Bootstrap(home: "", urls: [])), "폴더를 모르면 같다고 하지 않는다")
        XCTAssertFalse(same(ip, "https://other-mac.tail1234.ts.net", server: Bootstrap(home: home, urls: ["http://100.64.0.10:7878"])),
                       "다른 기기는 폴더 이름이 같아도 다른 서버")
        XCTAssertFalse(same(ip, https, server: Bootstrap(home: home, urls: ["http://100.64.0.9:7879"])), "알려 준 주소는 포트까지 맞아야 한다")
        XCTAssertFalse(same("http://127.0.0.1:7878", https, server: Bootstrap(home: home, urls: ["http://127.0.0.1:7878"])),
                       "어느 Mac 에서나 자기 자신인 127.0.0.1 은 알려 줘도 세지 않는다")
        XCTAssertFalse(same(https, "http://127.0.0.1:7878", owner: QueueOwner(home: home, addresses: ["http://127.0.0.1:7878"])))
        XCTAssertFalse(same("주소 아님", https))
    }

    /// 4차 리뷰 data-5: 보관했거나 지운 프로젝트에 둔 글은 보낼 곳이 없다. '다른 프로젝트를 열면 보낸다'고 세지 않고,
    /// 따로 보이며 지울 수 있다.
    func testQueuedMessagesForAGoneProjectCanBeSeenAndDeleted() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let offline = OfflineStateStore(directory: root)
        let here = DraftStore.endpointNamespace(net.endpoint)
        let gone = try offline.enqueue(namespace: here, projectID: "archived", targetMemberID: "x", targetName: "결제 연동",
                                       text: "보관한 프로젝트에 둔 글")
        let store = try store(net, offline: offline)
        await store.connect()
        XCTAssertEqual(store.selectedProjectID, "p")
        XCTAssertEqual(store.orphanQueuedMessages.map(\.id), [gone.id])
        XCTAssertEqual(store.queuedElsewhereCount, 0, "그 프로젝트를 열면 보낸다고 세지 않는다")
        XCTAssertTrue(store.queuedMessages.isEmpty)
        XCTAssertNil(store.deleteQueuedMessage(id: gone.id))
        XCTAssertTrue(store.orphanQueuedMessages.isEmpty)
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "보낼 곳이 없는 글은 보내지 않는다")
        store.disconnect()
    }

    func testOversizedStateIsTrimmedOrNotKept() throws {
        let big = ProjectState(project: Project(id: "p"),
                               messages: (0..<200).map { Message(id: "m\($0)", projectId: "p", body: String(repeating: "가", count: 400)) },
                               files: [FileDoc(id: "f", projectId: "p", body: String(repeating: "x", count: 60_000))])
        let snapshot = LastSeenSnapshot(namespace: "n", savedAt: Date(), serverID: nil,
                                        bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: big)
        let full = try JSONEncoder().encode(snapshot)
        XCTAssertEqual(OfflineStateStore.encodeWithinLimit(snapshot, limit: full.count)?.count, full.count, "상한 안이면 덜어 내지 않는다")
        let data = try XCTUnwrap(OfflineStateStore.encodeWithinLimit(snapshot, limit: full.count - 1))
        let trimmed = try JSONDecoder().decode(LastSeenSnapshot.self, from: data)
        XCTAssertEqual(trimmed.state?.messages.count, OfflineStateStore.trimmedMessageCount)
        XCTAssertEqual(trimmed.state?.messages.last?.id, "m199", "최근 글을 남긴다")
        XCTAssertEqual(trimmed.state?.files.first?.body, "")
        XCTAssertNil(OfflineStateStore.encodeWithinLimit(snapshot, limit: 2_000), "상한을 넘으면 남기지 않는다")
    }

    func testNotificationTapWhileOfflineOpensTheScreenAndKeepsTheLink() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(); switches.down = true
        let net = try network(WriteTestServer(), switches)
        let offline = OfflineStateStore(directory: root)
        let serverID = UUID().uuidString.lowercased()
        await seed(offline, net, serverID: serverID)
        let store = try store(net, offline: offline)
        store.restoreLastSeen()
        let router = Router(destination: .home)
        let inbox = NotificationInbox()
        let link = try XCTUnwrap(NotificationLink(url: try XCTUnwrap(URL(string: "iamceo://open/\(serverID)/projects/p/decisions/d1"))))
        inbox.receive(link, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(router.destination, .inbox)
        XCTAssertEqual(router.decisionID, "d1")
        XCTAssertEqual(inbox.pending.count, 1, "연결되면 서버에 확인한 뒤 평소대로 연다")
        router.go(.home)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(router.destination, .home, "같은 알림으로 다시 옮기지 않는다")
        let missing = try XCTUnwrap(NotificationLink(url: try XCTUnwrap(URL(string: "iamceo://open/\(serverID)/projects/p/decisions/d9"))))
        inbox.receive(missing, tapped: true)
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(router.destination, .inbox)
        XCTAssertNotNil(store.notificationNotice, "아직 받지 못한 결재라고 알린다")
    }

    func testScreenPreviewStaysOnTheDeviceAndShowsTheTailscaleReason() async throws {
        let store = AppStore.lastSeenPreview()
        defer { store.prepareForReplacement() }
        XCTAssertNotNil(store.lastSeen)
        XCTAssertEqual(store.queuedMessages.count, 2)
        XCTAssertFalse(store.offline.enabled, "견본은 파일을 쓰지 않는다")
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertTrue(store.lastSeenAnnounced)
        XCTAssertEqual(store.connectionIssue, Tailnet.offMessage, "요청은 Tailscale 확인에서 멈춘다(기기를 떠나지 않는다)")
        XCTAssertNotNil(store.lastSeen)
    }

    // MARK: Outbox

    func testQueuedMessagesAreSentOnceInOrderWhenConnected() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        await store.connect()
        XCTAssertNotNil(store.queueBlockReason(targetMemberID: nil), "빈 글은 두지 않는다")
        drafts.setText("첫 지시", for: leadKey)
        XCTAssertNil(store.queueBlockReason(targetMemberID: nil))
        XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        XCTAssertEqual(drafts.text(for: leadKey), "", "기기에 남긴 뒤 입력칸을 비운다")
        drafts.setText("둘째", for: memberKey)
        XCTAssertTrue(store.queueMessage(targetMemberID: "m"))
        drafts.setText("아직 쓰는 중", for: leadKey)
        XCTAssertEqual(store.queuedMessages.map(\.text), ["첫 지시", "둘째"])
        XCTAssertEqual(store.queuedMessages.map(\.targetMemberID), [nil, "m"])
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty })
        // 앱을 다시 켜도 남아 있다.
        XCTAssertEqual(OfflineStateStore(directory: root).items(namespace: store.writeNamespace).map(\.text), ["첫 지시", "둘째"])
        XCTAssertEqual(try permissions(root.appendingPathComponent("outbox.json")), 0o600)

        switches.down = false
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        let sent = server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }
        XCTAssertEqual(sent, ["첫 지시", "둘째"])
        XCTAssertEqual(server.read { $0.messages[$0.sentIDs[1]]?.targetMemberId }, "m")
        XCTAssertEqual(drafts.text(for: leadKey), "아직 쓰는 중", "보내는 동안 쓰던 초안은 건드리지 않는다")
        XCTAssertTrue(offline.sent(namespace: store.writeNamespace).isEmpty)
        await store.refresh()
        XCTAssertEqual(server.read { $0.sentIDs.count }, 2, "보낸 글을 다시 보내지 않는다")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("outbox.json").path), "비면 파일을 지운다")
        store.disconnect()
    }

    func testUnknownResultIsNeverResentAndHoldsTheRest() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        drafts.setText("하나", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        drafts.setText("둘", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        server.change { $0.dropMessage = true }
        switches.down = false
        await store.connect()
        try await waitWhile { server.read { $0.sentIDs.isEmpty } || store.outboxFlushing }
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        XCTAssertEqual(store.queuedMessages.map(\.text), ["둘"], "앞선 글의 결과를 모르면 다음 글은 기다린다")
        XCTAssertEqual(offline.sent(namespace: store.writeNamespace).count, 1)
        let first = try XCTUnwrap(server.read { $0.sentIDs.first })
        server.change { $0.dropMessage = false }
        await store.refresh()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        let ids = server.read { $0.sentIDs }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids.filter { $0 == first }.count, 1, "결과를 모르던 글은 접수 확인이 같은 ID 로 찾는다. 다시 보내지 않는다")
        XCTAssertEqual(store.submissions?.messageAttempt(id: first)?.status, .accepted)
        store.disconnect()
    }

    func testRefusalPausesTheRestUntilTheOwnerResumes() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        drafts.setText("거절될 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        drafts.setText("다음 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        switches.down = false; switches.refuseMessages = true
        await store.connect()
        try await waitWhile { store.outboxPausedReason == nil }
        XCTAssertEqual(store.queuedMessages.map(\.text), ["다음 글"])
        let failures = store.submissions?.failureNotices(namespace: store.writeNamespace, key: leadKey, drafts: drafts) ?? []
        XCTAssertEqual(failures.map(\.draft.text), ["거절될 글"], "입력칸 위에 '보내지 못한 글'로 남는다(다시 보내기·입력칸에 넣기·버리기)")
        XCTAssertEqual(failures.first?.failureDisposition, .retained)
        await store.refresh()
        XCTAssertEqual(store.queuedMessages.count, 1, "멈춘 동안에는 보내지 않는다")
        switches.refuseMessages = false
        store.resumeOutbox()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertNil(store.outboxPausedReason)
        XCTAssertEqual(server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }, ["다음 글"])
        store.disconnect()
    }

    func testOwnerCanEditAndDeleteBeforeSendingAndLeavingClearsTheQueue() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(); switches.down = true
        let net = try network(WriteTestServer(), switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        drafts.setText("고칠 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        drafts.setText("지울 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        let original = try XCTUnwrap(store.queuedMessages.first)
        XCTAssertNil(store.editQueuedMessage(id: original.id, text: "고친 글"))
        let edited = try XCTUnwrap(store.queuedMessages.first)
        XCTAssertEqual(edited.text, "고친 글")
        XCTAssertNotEqual(edited.id, original.id, "고친 글은 새 글이다(보내다 끊긴 옛 기록과 섞이지 않게)")
        XCTAssertNotNil(edited.editedAt)
        XCTAssertEqual(edited.createdAt, original.createdAt, "자리(순서)는 그대로")
        XCTAssertNotNil(store.editQueuedMessage(id: edited.id, text: "  "), "빈 글로 고치지 않는다")
        XCTAssertNil(store.deleteQueuedMessage(id: store.queuedMessages[1].id))
        XCTAssertNotNil(store.deleteQueuedMessage(id: "없는 글"))
        XCTAssertEqual(OfflineStateStore(directory: root).items(namespace: store.writeNamespace).map(\.text), ["고친 글"])
        // 첨부가 있는 글은 연결된 뒤에.
        drafts.setText("첨부와 함께", for: leadKey)
        drafts.addFile(Attachment(id: "file", url: "/uploads/file"), for: leadKey)
        XCTAssertEqual(store.queueBlockReason(targetMemberID: nil), "첨부가 있는 글은 연결된 뒤에 보내 주세요.")
        XCTAssertFalse(store.queueMessage(targetMemberID: nil))
        XCTAssertEqual(store.queuedMessages.count, 1)
        store.disconnect()
        XCTAssertTrue(OfflineStateStore(directory: root).outbox.items.isEmpty, "이 기기에서 나가면 그 서버의 대기열도 지운다")
    }

    func testMessageInterruptedBeforeSendingIsSentOnceWithTheSameRecord() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false), submissions = try SubmissionStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts, submissions: submissions)
        store.restoreLastSeen()
        drafts.setText("끊기기 전 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        let item = try XCTUnwrap(store.queuedMessages.first)
        // 보내기 직전(전송 기록만 준비)에 앱이 꺼졌다.
        let prepared = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: DraftSnapshot(
            namespace: item.namespace, key: item.draftKey, generation: item.draftGeneration, revision: 0, textRevision: 0,
            text: item.text, attachments: [], attachmentRevisions: [:]))
        switches.down = false
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(server.read { $0.sentIDs }, [prepared.id])
    }

    func testMessageThatAlreadyLeftIsNotSentAgain() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false), submissions = try SubmissionStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts, submissions: submissions)
        store.restoreLastSeen()
        drafts.setText("나간 글", for: leadKey); XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        let item = try XCTUnwrap(store.queuedMessages.first)
        // 보내기 시작한 기록은 남았는데 대기열에서 빼기 전에 앱이 꺼졌다. 서버는 받지 못했다.
        let began = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: DraftSnapshot(
            namespace: item.namespace, key: item.draftKey, generation: item.draftGeneration, revision: 0, textRevision: 0,
            text: item.text, attachments: [], attachmentRevisions: [:]))
        _ = try submissions.beginMessage(id: began.id)
        switches.down = false
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "결과를 모르던 글은 다시 보내지 않는다")
        await store.refresh()
        try await waitWhile { store.outboxPausedReason == nil }
        XCTAssertEqual(store.submissions?.failureNotices(namespace: store.writeNamespace, key: leadKey, drafts: drafts).map(\.id), [began.id],
                       "서버가 받지 않은 것이 확인되면 '보내지 못한 글'로 보여 대표가 고른다")
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty })
        store.disconnect()
    }

    /// 4차 리뷰 data-1: 같은 입력칸에서 앞서 보낸 글의 결과를 모르는 동안에는 '연결되면 보내기'로 넣지 않는다.
    /// 넣게 두면 그 글이 접수된 것으로 밝혀진 뒤 대기열이 같은 글을 새 기록으로 한 번 더 보낸다.
    func testUnresolvedSendBlocksQueueingTheSameText() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), switches = OfflineSwitches()
        switches.down = true
        let net = try network(server, switches)
        let offline = OfflineStateStore(directory: root)
        await seed(offline, net)
        let drafts = DraftStore(persist: false), submissions = try SubmissionStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts, submissions: submissions)
        store.restoreLastSeen()
        // 끊기기 직전에 보낸 글: 서버는 받았지만 앱은 답을 못 받아 결과를 모른다(입력칸에 글이 그대로 있다).
        drafts.setText("결과 모르는 글", for: leadKey)
        let checking = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: leadKey))
        _ = try submissions.beginMessage(id: checking.id)
        server.change { $0.messages[checking.id] = Message(id: checking.id, projectId: "p", mine: true, body: "결과 모르는 글") }
        await store.connect()
        XCTAssertTrue(store.waitsForConnection)
        XCTAssertEqual(store.queueBlockReason(targetMemberID: nil), "앞서 보낸 글의 접수를 확인한 뒤 넣어 주세요.")
        XCTAssertFalse(store.queueMessage(targetMemberID: nil))
        XCTAssertTrue(store.queuedMessages.isEmpty)
        XCTAssertEqual(drafts.text(for: leadKey), "결과 모르는 글", "막으면 입력칸의 글은 그대로")
        // 다른 사람에게 쓰는 글은 따로라 둘 수 있다.
        drafts.setText("다른 사람에게", for: memberKey)
        XCTAssertNil(store.queueBlockReason(targetMemberID: "m"))

        switches.down = false
        await store.connect()
        try await waitWhile { store.submissions?.messageAttempt(id: checking.id)?.status == .checking || store.outboxFlushing }
        XCTAssertEqual(store.submissions?.messageAttempt(id: checking.id)?.status, .accepted)
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "접수 확인이 같은 ID 로 찾았다. 같은 글을 다시 보내지 않는다")
        store.disconnect()
    }
}

// MARK: - V(0.2.5) 대기열 서버 신원

/// V: 대기열의 글은 쓴 서버의 것이다. 서버 ID(Bootstrap.server.id)로 가르고, 다른 서버에 붙은 동안에는 보내지 않고 남기며,
/// 쓴 지 하루가 넘은 글은 대표가 고르기 전에는 보내지 않고, 30일이 지나면 지운다.
extension OfflineStateTests {
    private func identify(_ server: WriteTestServer, _ id: String?) {
        server.change { $0.bootstrap.server = id.map { ServerVersionInfo(version: "0.2.5", apiLevel: 1, id: $0) } }
    }
    private func sentBodies(_ server: WriteTestServer) -> [String] {
        server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }
    }

    /// 같은 주소라도 서버 ID 가 다르면(다시 설치했거나 다른 데이터 폴더로 띄운 서버) 그 글을 보내지 않는다. 지우지도 않는다.
    /// 그 서버에 다시 붙으면 순서대로 보낸다.
    func testServerIDDecidesWhoseQueueItIs() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let offline = OfflineStateStore(directory: root)
        let here = DraftStore.endpointNamespace(net.endpoint)
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "A 에 갈 글 1", serverID: "server-a")
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: "m", targetName: "결제 연동", text: "A 에 갈 글 2", serverID: "server-a")
        identify(server, "server-b")
        let store = try store(net, offline: offline)
        await store.connect()
        await store.refresh()
        XCTAssertEqual(store.currentServerID, "server-b")
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "다른 서버로는 보내지 않는다")
        XCTAssertTrue(store.queuedMessages.isEmpty)
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["A 에 갈 글 1", "A 에 갈 글 2"])
        XCTAssertEqual(OfflineStateStore(directory: root).items(namespace: here).count, 2, "말없이 지우지 않는다")
        // 상한은 서버마다 센다: B 에 쓸 자리는 A 의 글이 먹지 않는다.
        XCTAssertEqual(offline.count(namespace: here, serverID: "server-b"), 0)

        identify(server, "server-a")
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(sentBodies(server), ["A 에 갈 글 1", "A 에 갈 글 2"])
        XCTAssertTrue(store.otherServerQueuedMessages.isEmpty)
        store.disconnect()
    }

    /// 같은 서버 ID 면 주소가 달라도(표지가 없어 예전 판정으로는 다른 서버였던 글도) 이 주소로 모아 보낸다.
    func testSameServerIDAtAnotherAddressIsSent() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        identify(server, "server-a")
        let offline = OfflineStateStore(directory: root)
        let before = "http://100.64.0.9:7878"
        _ = try offline.enqueue(namespace: before, projectID: "p", targetMemberID: nil, targetName: nil, text: "옛 주소의 A 글", serverID: "server-a")
        _ = try offline.enqueue(namespace: before, projectID: "p", targetMemberID: nil, targetName: nil, text: "표지 없는 옛 글")
        let store = try store(net, offline: offline)
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(sentBodies(server), ["옛 주소의 A 글"])
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["표지 없는 옛 글"], "ID 도 표지도 없는 다른 주소의 글은 다른 서버 몫")
        store.disconnect()
    }

    /// ID 를 남기기 전 판(0.2.4)의 글은 예전 판정으로 이 서버 것이 되면 이 서버의 ID 를 단다. 그 뒤 같은 주소에 다른 서버가 떠도
    /// 그 서버로 가지 않는다.
    func testLegacyMessagesTakeTheServerIDWhenAdopted() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        identify(server, "server-a")
        let offline = OfflineStateStore(directory: root)
        let here = DraftStore.endpointNamespace(net.endpoint)
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "0.2.4 에서 쓴 글")
        try offline.pause(namespace: here, reason: "멈춤")
        let store = try store(net, offline: offline)
        await store.connect()
        await store.refresh()
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.map(\.serverID), ["server-a"])
        XCTAssertEqual(store.queuedMessages.map(\.text), ["0.2.4 에서 쓴 글"])

        identify(server, "server-b")
        await store.connect()
        store.resumeOutbox()
        await store.refresh()
        try await waitWhile { store.outboxFlushing }
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "ID 를 단 뒤에는 같은 주소의 다른 서버로 가지 않는다")
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["0.2.4 에서 쓴 글"])
        store.disconnect()
    }

    /// 쓴 지 하루가 넘은 글은 연결돼도 저절로 보내지 않는다. 순서를 지켜 뒤의 글도 기다린다. 대표가 보내기를 고르면 순서대로 보내고,
    /// 고치면 새로 쓴 글이라 바로 보낸다.
    func testMessagesOlderThanADayWaitForTheOwner() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        identify(server, "server-a")
        let offline = OfflineStateStore(directory: root)
        let here = DraftStore.endpointNamespace(net.endpoint)
        let stale = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "어제 쓴 글",
                                        serverID: "server-a", now: Date(timeIntervalSinceNow: -25 * 3600))
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "방금 쓴 글", serverID: "server-a")
        let store = try store(net, offline: offline)
        await store.connect()
        await store.refresh()
        try await waitWhile { store.outboxFlushing }
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "하루가 넘은 글은 저절로 보내지 않고, 그 뒤의 글도 앞지르지 않는다")
        XCTAssertEqual(store.queuedNeedingReview.map(\.text), ["어제 쓴 글"])
        XCTAssertEqual(store.queuedMessages.count, 2)

        XCTAssertNil(store.confirmQueuedMessage(id: stale.id))
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(sentBodies(server), ["어제 쓴 글", "방금 쓴 글"])

        let older = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "그제 쓴 글",
                                        serverID: "server-a", now: Date(timeIntervalSinceNow: -50 * 3600))
        await store.refresh()
        try await waitWhile { store.outboxFlushing }
        XCTAssertEqual(server.read { $0.sentIDs.count }, 2)
        XCTAssertNil(store.editQueuedMessage(id: older.id, text: "그제 쓴 글을 고침"))
        XCTAssertTrue(store.queuedNeedingReview.isEmpty, "고친 글은 새로 쓴 글이다")
        await store.refresh()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(sentBodies(server).last, "그제 쓴 글을 고침")
        store.disconnect()
    }

    /// 30일이 지난 글은 기기에서 지운다(다른 서버 몫도). 지우기 전 마지막 7일은 '곧 지워짐'. 고치거나 보내기를 고르면 그때부터 다시 센다.
    func testMessagesExpireAfterThirtyDays() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let day: TimeInterval = 24 * 3600
        let offline = OfflineStateStore(directory: root)
        let mine = "http://100.64.0.9:7878", other = "http://100.64.0.10:7878"
        _ = try offline.enqueue(namespace: mine, projectID: "p", targetMemberID: nil, targetName: nil, text: "31일 전", now: Date(timeIntervalSinceNow: -31 * day))
        _ = try offline.enqueue(namespace: other, projectID: "p", targetMemberID: nil, targetName: nil, text: "31일 전 다른 서버",
                                serverID: "server-b", now: Date(timeIntervalSinceNow: -31 * day))
        try offline.pause(namespace: other, reason: "멈춤")
        let soon = try offline.enqueue(namespace: mine, projectID: "p", targetMemberID: nil, targetName: nil, text: "24일 전", now: Date(timeIntervalSinceNow: -24 * day))
        let recent = try offline.enqueue(namespace: mine, projectID: "p", targetMemberID: nil, targetName: nil, text: "그제", now: Date(timeIntervalSinceNow: -2 * day))

        let reopened = OfflineStateStore(directory: root)
        XCTAssertEqual(reopened.outbox.items.map(\.text), ["24일 전", "그제"], "읽자마자 30일이 지난 글을 지운다")
        XCTAssertNil(reopened.pausedReason(namespace: other), "글이 남지 않은 주소의 멈춤도 푼다")
        XCTAssertTrue(soon.expiresSoon())
        XCTAssertFalse(recent.expiresSoon())
        XCTAssertTrue(recent.needsReview())
        XCTAssertEqual(reopened.purgeExpired(now: Date(timeIntervalSinceNow: 7 * day)), 1, "24일 전 글은 일주일 뒤 지워진다")

        try reopened.confirm(id: recent.id)
        let confirmed = try XCTUnwrap(reopened.outbox.items.first { $0.id == recent.id })
        XCTAssertFalse(confirmed.needsReview(), "보내기를 고르면 다시 하루 동안은 저절로 보낸다")
        XCTAssertFalse(confirmed.expiresSoon())
        let edited = try reopened.replaceText(id: recent.id, with: "고친 글")
        XCTAssertFalse(edited.needsReview())
        XCTAssertNil(edited.confirmedAt)
    }

    /// '나가기'는 이 서버의 글만 지운다. 다른 서버에 보내려던 글은 남는다(그 서버에 다시 붙으면 보낸다).
    func testLeavingKeepsAnotherServersQueue() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let switches = OfflineSwitches(); switches.down = true
        let net = try network(WriteTestServer(), switches)
        let offline = OfflineStateStore(directory: root)
        await offline.saveLastSeen(LastSeenSnapshot(namespace: DraftStore.endpointNamespace(net.endpoint), savedAt: Date(timeIntervalSinceNow: -60),
                                                    serverID: nil,
                                                    bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")],
                                                                         server: ServerVersionInfo(version: "0.2.5", apiLevel: 1, id: "server-a")),
                                                    state: lastState()))
        _ = try offline.enqueue(namespace: "http://100.64.0.10:7878", projectID: "q", targetMemberID: nil, targetName: nil,
                                text: "B 에 갈 글", serverID: "server-b")
        let drafts = DraftStore(persist: false)
        let store = try store(net, offline: offline, drafts: drafts)
        store.restoreLastSeen()
        drafts.setText("A 에 갈 글", for: leadKey)
        XCTAssertTrue(store.queueMessage(targetMemberID: nil))
        XCTAssertEqual(store.queuedMessages.first?.serverID, "server-a", "넣을 때 보던 서버의 ID 를 단다")
        XCTAssertEqual(store.queuedForThisServerCount, 1, "나가기 확인 창은 이 서버의 글만 센다")
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["B 에 갈 글"])
        store.disconnect()
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.map(\.text), ["B 에 갈 글"])
    }

    /// 옛 주소에 두 서버의 글이 섞여 있을 때 이 서버의 글만 옮긴다. 다른 서버로 보낸 글의 기다리던 결과는 남기고,
    /// 이 서버로 보낸 글의 결과를 모르면 옮긴 글을 멈춰 둔다(순서를 지킨다).
    func testAdoptMovesOnlyThisServersMessagesAndResults() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let offline = OfflineStateStore(directory: root)
        let from = "http://100.64.0.9:7878", to = "http://127.0.0.1:7878"
        let mine = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "A", serverID: "server-a")
        _ = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "B", serverID: "server-b")
        let sentA = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "A 보냄", serverID: "server-a")
        try offline.markSent(id: sentA.id, attemptID: "sent-a")
        let sentB = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "B 보냄", serverID: "server-b")
        try offline.markSent(id: sentB.id, attemptID: "sent-b")
        try offline.adopt([mine.id], into: to, serverID: "server-a", owner: QueueOwner(home: "/h", addresses: []), waitingReason: "기다림")
        XCTAssertEqual(offline.items(namespace: to).map(\.text), ["A"])
        XCTAssertEqual(offline.items(namespace: from).map(\.text), ["B"])
        XCTAssertEqual(offline.sent(namespace: from).map(\.attemptID), ["sent-b"], "다른 서버로 보낸 글의 결과는 그 서버에 다시 붙을 때 본다")
        XCTAssertEqual(offline.pausedReason(namespace: to), "기다림", "이 서버로 보낸 글의 결과를 모른 채 주소가 바뀌었다")
        XCTAssertNil(offline.pausedReason(namespace: from))
    }

    /// 서버 ID 는 비교할 모양으로 읽고, 어긋난 값은 버전 정보를 살린 채 버린다. ID 칸이 없던 판(0.2.4)의 대기열 파일도 읽힌다.
    func testServerIDDecodingAndOldQueueFiles() throws {
        let decoded = try JSONDecoder().decode(ServerVersionInfo.self, from: Data(#"{"version":"0.2.5","apiLevel":1,"id":" ABC-def_1 "}"#.utf8))
        XCTAssertEqual(decoded.id, "abc-def_1")
        let odd = try JSONDecoder().decode(ServerVersionInfo.self, from: Data(#"{"version":"0.2.5","apiLevel":1,"id":5}"#.utf8))
        XCTAssertNil(odd.id)
        XCTAssertEqual(odd.version, "0.2.5")
        XCTAssertNil(ServerVersionInfo.normalizedID("a b"))
        XCTAssertNil(ServerVersionInfo.normalizedID(String(repeating: "a", count: 65)))
        let old = try JSONDecoder().decode(Bootstrap.self, from: Data(#"{"projects":[],"server":{"version":"0.2.4","apiLevel":1}}"#.utf8))
        XCTAssertEqual(old.server, ServerVersionInfo(version: "0.2.4", apiLevel: 1))

        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let written = Date().timeIntervalSinceReferenceDate - 60
        let file = #"{"items":[{"id":"6C1F2A9E-1B7D-4E7A-9C55-3E1D2F4A5B6C","namespace":"http://100.64.0.9:7878","projectID":"p","text":"옛 글","createdAt":\#(written)}],"sent":[{"attemptID":"x","namespace":"http://100.64.0.9:7878"}],"paused":{}}"#
        try Data(file.utf8).write(to: root.appendingPathComponent("outbox.json"))
        let offline = OfflineStateStore(directory: root)
        XCTAssertEqual(offline.outbox.items.map(\.text), ["옛 글"])
        XCTAssertNil(offline.outbox.items.first?.serverID)
        XCTAssertNil(offline.outbox.sent.first?.serverID)
    }

    /// 화면 견본(--outbox-preview): 확인 필요 한 개, 다른 서버 몫 두 개(하나는 곧 지워짐). 기기를 떠나지 않는다.
    func testOutboxPreviewShowsEveryNewState() {
        let store = AppStore.lastSeenPreview(outbox: true)
        defer { store.prepareForReplacement() }
        XCTAssertEqual(store.queuedMessages.count, 3)
        XCTAssertEqual(store.queuedNeedingReview.count, 1)
        XCTAssertEqual(store.otherServerQueuedMessages.count, 2)
        XCTAssertEqual(store.otherServerQueuedMessages.filter { $0.expiresSoon() }.count, 1)
        XCTAssertFalse(store.offline.enabled)
    }
}

// MARK: - 0.2.5 리뷰 수정(safety-1~5)

extension OfflineStateTests {
    private func identify(_ server: WriteTestServer, _ id: String?, home: String) {
        server.change { $0.bootstrap.home = home; $0.bootstrap.server = id.map { ServerVersionInfo(version: "0.2.5", apiLevel: 1, id: $0) } }
    }
    private func bodies(_ server: WriteTestServer) -> [String] {
        server.read { server in server.sentIDs.map { server.messages[$0]?.body ?? "" } }
    }

    /// safety-1: 서버 ID 가 같아도 데이터 폴더가 다르면(같은 곳 복원으로 다른 폴더에 만든 사본, DB 를 복사한 시험 서버) 다른 서버다.
    /// 글을 보내지 않고 '다른 서버'로 남긴다. 원래 서버(같은 폴더)에 다시 붙으면 보낸다.
    func testSameServerIDInAnotherDataFolderIsAnotherServer() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let here = DraftStore.endpointNamespace(net.endpoint)
        let live = "/Users/owner/.iamceo", copy = "/private/tmp/iamceo-copy"
        let offline = OfflineStateStore(directory: root)
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "라이브 총괄에게",
                                owner: QueueOwner(home: live, addresses: []), serverID: "server-a")
        identify(server, "server-a", home: copy)
        let store = try store(net, offline: offline)
        await store.connect()
        await store.refresh()
        try await waitWhile { store.outboxFlushing }
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "ID 가 같아도 폴더가 다른 사본으로는 보내지 않는다")
        XCTAssertEqual(store.otherServerQueuedMessages.map(\.text), ["라이브 총괄에게"])
        XCTAssertTrue(store.queuedMessages.isEmpty)
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.first?.owner?.home, live, "표지를 사본의 것으로 바꾸지 않는다")

        identify(server, "server-a", home: live)
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertEqual(bodies(server), ["라이브 총괄에게"])
        store.disconnect()
    }

    /// safety-1: 판정 규칙(순수 함수). 폴더를 둘 다 알고 다르면 다른 서버, 그 밖에는 ID 로, ID 를 모르면 예전 판정.
    func testServerIdentityRule() {
        XCTAssertEqual(ServerIdentity.same(id: "a", home: "/x", as: "a", home: "/x"), true)
        XCTAssertEqual(ServerIdentity.same(id: "a", home: "/x", as: "a", home: "/y"), false)
        XCTAssertEqual(ServerIdentity.same(id: "a", home: nil, as: "a", home: "/y"), true, "폴더를 하나만 알면 ID 로")
        XCTAssertEqual(ServerIdentity.same(id: "a", home: "", as: "a", home: "/y"), true, "빈 폴더는 모르는 것")
        XCTAssertEqual(ServerIdentity.same(id: "a", home: "/x", as: "b", home: "/x"), false)
        XCTAssertNil(ServerIdentity.same(id: nil, home: "/x", as: "a", home: "/x"))
        XCTAssertEqual(ServerIdentity.same(id: nil, home: "/x", as: "a", home: "/y"), false)
        let item = QueuedMessage(id: UUID().uuidString, namespace: "http://100.64.0.9:7878", projectID: "p", targetMemberID: nil,
                                 targetName: nil, text: "글", createdAt: Date(), serverID: "a", owner: QueueOwner(home: "/x", addresses: []))
        let copy = Bootstrap(home: "/y", server: ServerVersionInfo(version: "0.2.5", apiLevel: 1, id: "a"))
        XCTAssertEqual(AppStore.splitOutbox([item], at: "http://127.0.0.1:7878", server: copy).elsewhere.map(\.id), [item.id])
        var original = copy; original.home = "/x"
        XCTAssertEqual(AppStore.splitOutbox([item], at: "http://127.0.0.1:7878", server: original).here.map(\.id), [item.id],
                       "같은 ID·같은 폴더면 주소가 달라도 같은 서버")
    }

    /// safety-1: 옛 주소의 '결과를 기다리는 기록'도 ID 가 같고 폴더가 다르면 지금 서버 것이 아니다(지우지 않는다).
    func testAdoptKeepsResultsSentToAnotherFolderWithTheSameID() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let offline = OfflineStateStore(directory: root)
        let from = "http://100.64.0.9:7878", to = "http://127.0.0.1:7878"
        let live = QueueOwner(home: "/live", addresses: []), copy = QueueOwner(home: "/copy", addresses: [])
        let mine = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "사본 글",
                                       owner: copy, serverID: "server-a")
        let liveSent = try offline.enqueue(namespace: from, projectID: "p", targetMemberID: nil, targetName: nil, text: "라이브로 보냄",
                                           owner: live, serverID: "server-a")
        try offline.markSent(id: liveSent.id, attemptID: "sent-live")
        XCTAssertEqual(offline.sent(namespace: from).first?.home, "/live", "보낸 기록에 그 서버의 폴더를 남긴다")
        try offline.adopt([mine.id], into: to, serverID: "server-a", owner: copy, waitingReason: "기다림")
        XCTAssertEqual(offline.sent(namespace: from).map(\.attemptID), ["sent-live"], "라이브로 보낸 글의 결과는 라이브에 다시 붙을 때 본다")
        XCTAssertNil(offline.pausedReason(namespace: to), "이 서버로 보낸 글은 결과를 기다리지 않는다")
    }

    /// safety-2: 표지는 글마다 고정된다. 0.2.4 파일의 글은 읽을 때 그 주소의 표지를 받는다. 뒤에 같은 주소에 데이터 폴더가 다른 서버가
    /// 붙어 거기서 글을 넣어도(주소의 표지가 덮여도) 옛 글은 그 서버 몫으로 뒤집히지 않는다.
    func testOwnerIsPinnedToEachMessage() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let address = "http://100.64.0.9:7878", written = Date().timeIntervalSinceReferenceDate - 60
        let file = #"{"items":[{"id":"6C1F2A9E-1B7D-4E7A-9C55-3E1D2F4A5B6C","namespace":"\#(address)","projectID":"p","text":"A 의 옛 글","createdAt":\#(written)}],"sent":[],"paused":{},"owners":{"\#(address)":{"home":"/a","addresses":[]}}}"#
        try Data(file.utf8).write(to: root.appendingPathComponent("outbox.json"))
        let offline = OfflineStateStore(directory: root)
        XCTAssertEqual(offline.outbox.items.first?.owner, QueueOwner(home: "/a", addresses: []), "읽을 때 주소의 표지를 글에 고정한다")
        // 같은 주소의 B(폴더가 다르고 ID 가 없는 옛 서버)가 끊긴 사이 B 에 글을 넣었다.
        _ = try offline.enqueue(namespace: address, projectID: "p", targetMemberID: nil, targetName: nil, text: "B 의 글",
                                owner: QueueOwner(home: "/b", addresses: []))
        XCTAssertEqual(offline.owner(namespace: address)?.home, "/b", "주소의 표지는 새 글의 것으로 바뀐다")
        let split = AppStore.splitOutbox(offline.outbox.items, at: address, server: Bootstrap(home: "/b"))
        XCTAssertEqual(split.here.map(\.text), ["B 의 글"])
        XCTAssertEqual(split.elsewhere.map(\.text), ["A 의 옛 글"], "옛 글은 B 몫으로 뒤집히지 않는다")
        XCTAssertEqual(OfflineStateStore(directory: root).outbox.items.map(\.owner?.home), ["/a", "/b"], "고정한 표지는 파일에도 남는다")
    }

    /// safety-5: 멈춤은 서버마다다. 같은 주소의 다른 서버에서는 A 의 멈춤이 보이지도, 막지도, 풀리지도 않는다. ID 를 모르면 주소 단위.
    func testPausesBelongToTheirServer() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let offline = OfflineStateStore(directory: root)
        let address = "http://100.64.0.9:7878"
        _ = try offline.enqueue(namespace: address, projectID: "p", targetMemberID: nil, targetName: nil, text: "A 의 둘째 글", serverID: "server-a")
        try offline.pause(namespace: address, serverID: "server-a", reason: "A 멈춤")
        XCTAssertNil(offline.pausedReason(namespace: address, serverID: "server-b"), "B 에서는 A 의 멈춤이 보이지 않고 B 를 막지 않는다")
        XCTAssertEqual(offline.pausedReason(namespace: address, serverID: "server-a"), "A 멈춤")
        XCTAssertEqual(offline.pausedReason(namespace: address), "A 멈춤", "ID 를 모르는 서버는 이 주소의 어느 멈춤이든 따른다")
        try offline.resume(namespace: address, serverID: "server-b")
        try offline.removeForLeaving(ids: [], namespace: address, serverID: "server-b")
        XCTAssertEqual(OfflineStateStore(directory: root).pausedReason(namespace: address, serverID: "server-a"), "A 멈춤",
                       "B 의 '이어서 보내기'·'나가기'가 A 의 순서 보호를 풀지 않는다")
        // ID 없이 남은 멈춤(0.2.4 파일, 옛 서버)은 주소 단위로 막는다.
        try offline.pause(namespace: address, reason: "옛 멈춤")
        XCTAssertEqual(offline.pausedReason(namespace: address, serverID: "server-b"), "옛 멈춤")
        try offline.resume(namespace: address, serverID: "server-b")
        XCTAssertNil(offline.pausedReason(namespace: address, serverID: "server-b"))
        XCTAssertEqual(offline.pausedReason(namespace: address, serverID: "server-a"), "A 멈춤")
        try offline.resume(namespace: address, serverID: "server-a")
        XCTAssertNil(offline.pausedReason(namespace: address))
        // 지운 글이 그 서버의 마지막 글이면 그 서버의 멈춤만 푼다.
        let b = try offline.enqueue(namespace: address, projectID: "p", targetMemberID: nil, targetName: nil, text: "B 의 글", serverID: "server-b")
        try offline.pause(namespace: address, serverID: "server-a", reason: "A 멈춤")
        try offline.pause(namespace: address, serverID: "server-b", reason: "B 멈춤")
        try offline.remove(id: b.id)
        XCTAssertNil(offline.pausedReason(namespace: address, serverID: "server-b"))
        XCTAssertEqual(offline.pausedReason(namespace: address, serverID: "server-a"), "A 멈춤")
    }

    /// safety-5: 앱에서. 같은 주소에 B 가 떠 있으면 A 의 멈춤은 B 의 대기열을 막지 않고 B 화면에 보이지 않는다. B 에서 나가도 A 의
    /// 멈춤은 남아, A 로 돌아갔을 때 남은 글이 저절로 가지 않는다.
    func testAnotherServerAtTheSameAddressDoesNotLiftThePause() async throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let here = DraftStore.endpointNamespace(net.endpoint)
        let offline = OfflineStateStore(directory: root)
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "A 의 둘째 글", serverID: "server-a")
        try offline.pause(namespace: here, serverID: "server-a", reason: "A 멈춤")
        _ = try offline.enqueue(namespace: here, projectID: "p", targetMemberID: nil, targetName: nil, text: "B 에 갈 글", serverID: "server-b")
        identify(server, "server-b", home: "/b")
        let store = try store(net, offline: offline)
        await store.connect()
        try await waitWhile { !store.queuedMessages.isEmpty || store.outboxFlushing }
        XCTAssertNil(store.outboxPausedReason)
        XCTAssertEqual(bodies(server), ["B 에 갈 글"])
        store.resumeOutbox()
        store.disconnect()
        XCTAssertEqual(OfflineStateStore(directory: root).pausedReason(namespace: here, serverID: "server-a"), "A 멈춤")

        identify(server, "server-a", home: "/a")
        let again = try self.store(net, offline: offline)
        await again.connect()
        await again.refresh()
        try await waitWhile { again.outboxFlushing }
        XCTAssertEqual(again.outboxPausedReason, "A 멈춤")
        XCTAssertEqual(bodies(server), ["B 에 갈 글"], "A 의 남은 글은 대표가 확인하기 전에는 가지 않는다")
        again.disconnect()
    }

    /// safety-3: 결과를 모르는 글이 다른 서버(같은 주소에 새로 뜬 서버)로 보낸 것이면 지금 서버에 묻지 않는다. 그 서버의 404 로
    /// '접수 안 됨'을 굳히지 않고 '확인 중'으로 두며, 보낸 서버에 다시 붙으면 그 서버에 물어 접수를 찾는다.
    func testUnknownResultIsCheckedOnlyWithTheServerItWasSentTo() async throws {
        let server = WriteTestServer()
        let net = try network(server, OfflineSwitches())
        let here = DraftStore.endpointNamespace(net.endpoint)
        let drafts = DraftStore(persist: false), submissions = try SubmissionStore(persist: false)
        drafts.selectNamespace(here)
        drafts.setText("응답을 잃은 글", for: leadKey)
        let attempt = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: leadKey))
        _ = try submissions.beginMessage(id: attempt.id, serverID: "server-a", serverHome: "/a")
        XCTAssertEqual(submissions.messageAttempt(id: attempt.id)?.serverID, "server-a", "보낸 서버의 신원을 기록에 남긴다")
        identify(server, "server-b", home: "/b")
        let store = try store(net, offline: OfflineStateStore(persist: false), drafts: drafts, submissions: submissions)
        await store.connect()
        await store.refresh()
        try await waitWhile { store.outboxFlushing }
        XCTAssertEqual(submissions.messageAttempt(id: attempt.id)?.status, .checking, "다른 서버의 404 로 '접수 안 됨'을 정하지 않는다")
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty })

        // A 에 다시 붙었다. A 는 그 글을 받아 두었다.
        server.change { $0.messages[attempt.id] = Message(id: attempt.id, projectId: "p", mine: true, body: "응답을 잃은 글") }
        identify(server, "server-a", home: "/a")
        await store.connect()
        try await waitWhile { submissions.messageAttempt(id: attempt.id)?.status == .checking || store.outboxFlushing }
        XCTAssertEqual(submissions.messageAttempt(id: attempt.id)?.status, .accepted)
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty }, "다시 보내지 않는다")
        store.disconnect()
    }

    /// safety-4: 기기 시계가 앞서 있을 때 쓴 글(지금보다 몇 분 넘게 미래)은 '확인 필요'로 본다. 보내기를 고르면 그때부터 하루.
    func testFutureTimestampsNeedReview() throws {
        let root = try folder(); defer { try? FileManager.default.removeItem(at: root) }
        let offline = OfflineStateStore(directory: root)
        let ahead = try offline.enqueue(namespace: "http://100.64.0.9:7878", projectID: "p", targetMemberID: nil, targetName: nil,
                                        text: "시계가 앞설 때 쓴 글", now: Date(timeIntervalSinceNow: 3 * 24 * 3600))
        XCTAssertTrue(ahead.needsReview(), "언제 쓴 글인지 믿을 수 없다")
        XCTAssertFalse(ahead.needsReview(now: ahead.createdAt), "그 시각 기준으로는 방금 쓴 글")
        let slight = try offline.enqueue(namespace: "http://100.64.0.9:7878", projectID: "p", targetMemberID: nil, targetName: nil,
                                         text: "조금 앞선 시계", now: Date(timeIntervalSinceNow: 60))
        XCTAssertFalse(slight.needsReview(), "몇 분 안의 차이는 그대로 둔다")
        try offline.confirm(id: ahead.id)
        let confirmed = try XCTUnwrap(offline.outbox.items.first { $0.id == ahead.id })
        XCTAssertFalse(confirmed.needsReview(), "보내기를 고른 때(지금)가 미래의 쓴 때를 가리지 않는다")
        XCTAssertEqual(confirmed.touchedAt, confirmed.confirmedAt)
    }
}
