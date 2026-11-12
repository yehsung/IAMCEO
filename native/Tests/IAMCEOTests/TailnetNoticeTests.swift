import Foundation
import XCTest
@testable import IAMCEO

/// Tailscale 꺼짐 안내(앱): 서버가 싣는 선택 필드 `tailnet` 을 관대하게 읽고, 서버가 있는 Mac 의 앱만 상태 띠 한 줄과
/// Mac 알림 한 번(꺼짐마다)으로 알린다. iPhone 은 조용하다: iPhone 이 서버에 닿았다면 그 길은 살아 있다.

#if os(macOS)
@MainActor private final class TailnetDelivery: MacNotificationDelivering {
    struct Notice: Equatable { let identifier: String; let title: String; let body: String }
    var notices: [Notice] = []
    var events = 0
    func requestPermission() async throws -> Bool { true }
    func deliver(identifier: String, title: String, metadata: Data) async throws { events += 1 }
    func deliverNotice(identifier: String, title: String, body: String) async throws {
        notices.append(Notice(identifier: identifier, title: title, body: body))
    }
    func clear() {}
}
#endif

@MainActor final class TailnetNoticeTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private let off = TailnetState(state: "off", lastAddress: "100.64.0.7", since: "2026-11-12T00:01:00.000Z")

    // MARK: 디코딩

    func testBootstrapReadsTheOptionalTailnetFieldLeniently() throws {
        XCTAssertNil(try decode(Bootstrap.self, #"{"projects":[]}"#).tailnet, "옛 서버, 또는 Tailscale 주소를 연 적이 없는 설치")
        XCTAssertEqual(try decode(Bootstrap.self, #"{"projects":[],"tailnet":{"state":"ok","lastAddress":"100.64.0.7"}}"#).tailnet,
                       TailnetState(state: "ok", lastAddress: "100.64.0.7"))
        let decoded = try decode(Bootstrap.self,
            #"{"projects":[],"tailnet":{"state":"off","lastAddress":"100.64.0.7","since":"2026-11-12T00:01:00.000Z","macNotified":true}}"#)
        XCTAssertEqual(decoded.tailnet, TailnetState(state: "off", lastAddress: "100.64.0.7", since: "2026-11-12T00:01:00.000Z", macNotified: true))
        // 모르는 값은 그대로 읽되 아무것도 띄우지 않는다.
        let unknown = try decode(Bootstrap.self, #"{"projects":[],"tailnet":{"state":"paused","extra":1}}"#)
        XCTAssertEqual(unknown.tailnet?.state, "paused")
        XCTAssertNil(TailnetNotice(unknown.tailnet, onThisMac: true))
        // 이 필드가 어긋나도 시작 응답 전체를 버리지 않는다.
        for broken in [#"{"projects":[],"tailnet":"off"}"#, #"{"projects":[],"tailnet":{"lastAddress":"100.64.0.7"}}"#, #"{"projects":[],"tailnet":{"state":3}}"#] {
            XCTAssertNil(try decode(Bootstrap.self, broken).tailnet, broken)
        }
        let loose = try decode(Bootstrap.self, #"{"projects":[],"tailnet":{"state":"off","since":7,"macNotified":"yes"}}"#)
        XCTAssertEqual(loose.tailnet, TailnetState(state: "off"))
        // 스냅샷(/api/sync)의 bootstrap 도 같은 모양이다. 엔진 안내와 서로 독립이다.
        let both = try decode(Bootstrap.self, #"{"projects":[],"engine":{"state":"ok"},"tailnet":{"state":"off"}}"#)
        XCTAssertNil(EngineNotice(both.engine))
        XCTAssertNotNil(TailnetNotice(both.tailnet, onThisMac: true))
    }

    // MARK: 상태 띠

    func testStripSpeaksOnlyForOffAndOnlyOnTheServersOwnMac() {
        XCTAssertEqual(TailnetNotice(off, onThisMac: true)?.text,
                       "Tailscale이 꺼져 있어 iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.")
        XCTAssertNil(TailnetNotice(off, onThisMac: false), "iPhone, 그리고 다른 Mac 에 붙은 Mac")
        XCTAssertNil(TailnetNotice(nil, onThisMac: true))
        XCTAssertNil(TailnetNotice(TailnetState(state: "ok", lastAddress: "100.64.0.7"), onThisMac: true), "다시 켜지면 사라진다")
        XCTAssertNil(TailnetNotice(TailnetState(state: "something_new"), onThisMac: true))
        // '이 Mac'은 같은 Mac 의 서버에 붙은 Mac 앱이다. iPhone 은 어떤 주소로 붙어도 아니다.
        XCTAssertNotNil(TailnetNotice(off, onThisMac: AppStore.serverIsThisMac(endpoint: "http://127.0.0.1:7878", onMac: true)))
        XCTAssertNil(TailnetNotice(off, onThisMac: AppStore.serverIsThisMac(endpoint: "http://127.0.0.1:7878", onMac: false)))
        XCTAssertNil(TailnetNotice(off, onThisMac: AppStore.serverIsThisMac(endpoint: "http://100.64.0.7:7878", onMac: true)))
        // 화면 글에 내부 용어가 없다.
        for word in ["tailnet", "hosts", "detect", "bind", "probe"] {
            XCTAssertFalse(TailnetNotice.stripText.lowercased().contains(word), word)
            XCTAssertFalse((TailnetNotice.notificationTitle + TailnetNotice.notificationBody).lowercased().contains(word), word)
        }
    }

    func testSampleModeHasNoTailnetNotice() {
        let (bootstrap, _) = DemoFixtures.workspace(now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertNil(bootstrap.tailnet)
        XCTAssertNil(TailnetNotice(bootstrap.tailnet, onThisMac: true))
    }

    // MARK: 알림은 꺼짐마다 한 번

    func testTrackerNotifiesOncePerOffPeriod() {
        var tracker = TailnetOffTracker()
        let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        XCTAssertFalse(tracker.shouldNotify(nil, serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(TailnetState(state: "ok"), serverID: server, appOwnsNotifications: true))
        XCTAssertTrue(tracker.shouldNotify(off, serverID: server, appOwnsNotifications: true))
        // 같은 꺼짐을 다시 읽어도, 연결이 끊겼다 붙어도(필드 없음) 다시 알리지 않는다.
        XCTAssertFalse(tracker.shouldNotify(off, serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(nil, serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(TailnetState(state: "something_new"), serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(off, serverID: server, appOwnsNotifications: true))
        // 다시 켜졌다가 또 꺼지면 새 꺼짐이다.
        XCTAssertFalse(tracker.shouldNotify(TailnetState(state: "ok"), serverID: server, appOwnsNotifications: true))
        var again = off; again.since = "2026-11-12T03:00:00.000Z"
        XCTAssertTrue(tracker.shouldNotify(again, serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(again, serverID: server, appOwnsNotifications: true))
        // 서버가 다시 떠서 같은 꺼짐을 새 시각으로 알리면 한 번 더 간다(허용된 동작). 다른 서버도 따로 센다.
        var restarted = off; restarted.since = "2026-11-12T03:30:00.000Z"
        XCTAssertTrue(tracker.shouldNotify(restarted, serverID: server, appOwnsNotifications: true))
        XCTAssertTrue(tracker.shouldNotify(restarted, serverID: "another-server", appOwnsNotifications: true))
        // 시각이 없는 꺼짐은 ok 를 들어야 끝난다.
        var plain = TailnetOffTracker()
        XCTAssertTrue(plain.shouldNotify(TailnetState(state: "off"), serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(plain.shouldNotify(TailnetState(state: "off"), serverID: server, appOwnsNotifications: true))
        XCTAssertFalse(plain.shouldNotify(TailnetState(state: "ok"), serverID: server, appOwnsNotifications: true))
        XCTAssertTrue(plain.shouldNotify(TailnetState(state: "off"), serverID: server, appOwnsNotifications: true))
    }

    func testTrackerLeavesTheNotificationToTheServerWhenItAlreadyPostedOne() {
        var tracker = TailnetOffTracker()
        var posted = off; posted.macNotified = true
        // 서버가 스크립트 알림으로 이미 띄운 꺼짐: 앱이 알림을 맡게 된 뒤에도 같은 꺼짐을 또 알리지 않는다.
        XCTAssertFalse(tracker.shouldNotify(posted, serverID: "s", appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(posted, serverID: "s", appOwnsNotifications: true))
        // 앱이 알림을 맡지 않는 동안에는 띄우지 않되 꺼짐을 닫지 않는다: 맡게 되면 그때 한 번 알린다.
        XCTAssertFalse(tracker.shouldNotify(off, serverID: "s", appOwnsNotifications: false))
        XCTAssertTrue(tracker.shouldNotify(off, serverID: "s", appOwnsNotifications: true))
        XCTAssertFalse(tracker.shouldNotify(off, serverID: "s", appOwnsNotifications: true))
    }

    #if os(macOS)
    func testMacAppPostsTheNoticeOncePerOffPeriodWithTheAgreedWords() async {
        let delivery = TailnetDelivery(), service = MacNotificationService(defaults: nil, delivery: delivery)
        let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        // Mac 알림을 켜지 않은 앱은 띄우지 않는다.
        XCTAssertNil(service.noteTailnet(off, serverID: server, appOwnsNotifications: true))
        await service.setEnabled(true)
        XCTAssertTrue(service.enabled)
        // 서버가 스크립트 알림을 맡고 있거나(macScriptNotifications 가 false 가 아님) 다른 Mac 의 서버면 앱은 띄우지 않는다.
        XCTAssertNil(service.noteTailnet(off, serverID: server, appOwnsNotifications: false))
        XCTAssertNil(service.noteTailnet(TailnetState(state: "ok"), serverID: server, appOwnsNotifications: true))
        XCTAssertNil(service.noteTailnet(nil, serverID: server, appOwnsNotifications: true))
        XCTAssertEqual(delivery.notices, [])

        _ = await service.noteTailnet(off, serverID: server, appOwnsNotifications: true)?.value
        XCTAssertEqual(delivery.notices, [TailnetDelivery.Notice(identifier: "\(server):tailnet_off", title: "Tailscale이 꺼져 있습니다",
                                                                 body: "iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.")])
        // 0.5초마다 다시 봐도 같은 꺼짐에는 한 번뿐이다.
        for _ in 0..<5 { XCTAssertNil(service.noteTailnet(off, serverID: server, appOwnsNotifications: true)) }
        XCTAssertEqual(delivery.notices.count, 1)

        XCTAssertNil(service.noteTailnet(TailnetState(state: "ok", lastAddress: "100.64.0.7"), serverID: server, appOwnsNotifications: true))
        var again = off; again.since = "2026-11-12T05:00:00.000Z"
        _ = await service.noteTailnet(again, serverID: server, appOwnsNotifications: true)?.value
        XCTAssertEqual(delivery.notices.count, 2)

        // 서버가 이미 띄웠다고 알린 꺼짐은 앱이 또 띄우지 않는다.
        var posted = off; posted.since = "2026-11-12T07:00:00.000Z"; posted.macNotified = true
        XCTAssertNil(service.noteTailnet(posted, serverID: server, appOwnsNotifications: true))
        XCTAssertEqual(delivery.notices.count, 2)
        XCTAssertEqual(delivery.events, 0)
        XCTAssertNil(service.permissionNotice)
    }
    #endif
}
