import Foundation
import XCTest
@testable import IAMCEO

/// G(C3): 설정 → 연결의 '연결된 기기'(GET /api/devices, DELETE /api/devices/:id).
/// 목록은 관대하게 읽고, 옛 서버(404)면 묶음을 그리지 않으며, 한 대만 끊은 뒤 목록을 다시 읽는다.
@MainActor final class ConnectedDevicesTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    nonisolated private static let list = #"""
    {"shared":{"lastSeenAt":"2026-11-13T02:58:00.000Z","platforms":[{"platform":"macos","lastSeenAt":"2026-11-13T02:58:00.000Z"},{"platform":"other","lastSeenAt":"2026-11-13T01:00:00.000Z"}],"current":true,"rotatedAt":null},
     "devices":[{"id":"devAAAAAAAAAAAAAAAA","name":"민수의 iPhone","platform":"ios","pairedAt":"2026-11-12T03:00:00.000Z","lastSeenAt":"2026-11-13T02:55:00.000Z","current":false},
                {"id":"devBBBBBBBBBBBBBBBB","name":"iPad","platform":null,"pairedAt":"2026-11-13T02:00:00.000Z","lastSeenAt":null,"current":false}],
     "failures":{"count":3,"days":7,"lastAt":"2026-11-13T02:30:00.000Z"},
     "events":[{"kind":"paired","at":"2026-11-13T02:00:00.000Z","lastAt":"2026-11-13T02:00:00.000Z","count":1,"address":"100.64.0.2","deviceName":"iPad","reason":null}]}
    """#

    func testListDecodesLenientlyAndReadsInPlainKorean() throws {
        let decoded = try decode(DeviceAccessList.self, Self.list)
        XCTAssertTrue(decoded.shared.current)
        XCTAssertEqual(decoded.devices.map(\.name), ["민수의 iPhone", "iPad"])
        XCTAssertEqual(decoded.failures, AccessFailures(count: 3, days: 7, lastAt: "2026-11-13T02:30:00.000Z"))
        let now = ISO8601DateFormatter().date(from: "2026-11-13T03:00:00Z")!
        XCTAssertEqual(ConnectedDevicesText.deviceHint(decoded.devices[0], now: now).components(separatedBy: " · ").prefix(2), ["iPhone", "마지막 접속 5분 전"])
        XCTAssertTrue(ConnectedDevicesText.deviceHint(decoded.devices[1], now: now).hasPrefix("아직 접속하지 않음 · 연결 1시간 전"))
        XCTAssertEqual(ConnectedDevicesText.sharedHint(decoded.shared, now: now), "마지막 접속 2분 전 · Mac 앱, 기타")
        XCTAssertEqual(ConnectedDevicesText.sharedHint(SharedCodeAccess(), now: now), "최근 접속 기록이 없습니다")
        XCTAssertEqual(ConnectedDevicesText.failureValue(decoded.failures), "7일간 3번")
        XCTAssertEqual(ConnectedDevicesText.failureValue(AccessFailures()), "없음")
        XCTAssertEqual(ConnectedDevicesText.failureHint(decoded.failures, now: now), "틀린 코드나 끊은 기기로 들어오려 한 횟수 · 마지막 30분 전")
        XCTAssertEqual(["ios", "macos", "local", "other", "새것"].map(ConnectedDevicesText.platformLabel), ["iPhone", "Mac 앱", "이 Mac", "기타", "기타"])
        // 지금 쓰는 기기를 끊을 때는 그 사실을 먼저 말한다.
        var mine = decoded.devices[0]; mine.current = true
        XCTAssertTrue(ConnectedDevicesText.confirmMessage(mine).hasPrefix("지금 쓰는 이 기기입니다."))
        XCTAssertEqual(ConnectedDevicesText.confirmTitle(mine), "‘민수의 iPhone’ 연결을 끊을까요?")
        // 모르는 칸·어긋난 원소는 그 원소만 버리고, 부가 정보가 어긋나도 목록은 읽는다. 기기 목록이 없으면 이 경로의 답이 아니다.
        let odd = try decode(DeviceAccessList.self, #"{"devices":[{"id":"devX","name":"x","pairedAt":"2026-11-13T00:00:00Z","extra":1},{"name":"id 없음"}],"shared":"bad","failures":{"count":"many"}}"#)
        XCTAssertEqual(odd.devices.map(\.id), ["devX"])
        XCTAssertFalse(odd.devices[0].current)
        XCTAssertEqual(odd.shared, SharedCodeAccess())
        XCTAssertEqual(odd.failures.count, 0)
        XCTAssertThrowsError(try decode(DeviceAccessList.self, #"{"shared":{}}"#))
    }

    func testLoadHidesOnAnOlderServerAndRevokesOneDevice() async throws {
        let box = DevicesReplyBox(status: 200, body: Self.list)
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "DELETE" {
                XCTAssertEqual(request.url?.path, "/api/devices/devAAAAAAAAAAAAAAAA")
                box.deleted()
                return IsolatedTestHTTPReply(status: 200, data: Data(#"{"ok":true,"device":{"id":"devAAAAAAAAAAAAAAAA","name":"민수의 iPhone","platform":"ios","pairedAt":"2026-11-12T03:00:00.000Z","lastSeenAt":null,"current":false}}"#.utf8))
            }
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/devices")
            let (status, body) = box.reply
            return IsolatedTestHTTPReply(status: status, data: Data(body.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = DevicesPanel()
        await panel.attach(api)
        XCTAssertEqual(panel.list?.devices.count, 2)
        XCTAssertFalse(panel.unsupported)

        // 끊고 나면 다시 읽는다(서버는 이제 한 대만 돌려준다).
        let device = try XCTUnwrap(panel.list?.devices.first)
        box.set(200, Self.list.replacingOccurrences(of: #"{"id":"devAAAAAAAAAAAAAAAA","name":"민수의 iPhone","platform":"ios","pairedAt":"2026-11-12T03:00:00.000Z","lastSeenAt":"2026-11-13T02:55:00.000Z","current":false},"#, with: ""))
        let revoked = await panel.revoke(device, api: api)
        XCTAssertTrue(revoked)
        XCTAssertEqual(box.deletes, 1)
        XCTAssertEqual(panel.list?.devices.map(\.name), ["iPad"])
        XCTAssertNil(panel.revoking)
        XCTAssertNil(panel.revokeError)

        // 다시 읽다 실패하면 마지막 목록은 두고 까닭만 보인다.
        box.set(500, #"{"error":"서버 오류","code":"internal_error"}"#)
        await panel.load(api)
        XCTAssertEqual(panel.list?.devices.count, 1)
        XCTAssertEqual(panel.error, "서버 오류")

        // 옛 서버는 경로를 모른다(404): 묶음을 그리지 않는다.
        box.set(404, #"{"error":"없는 경로입니다"}"#)
        await panel.load(api)
        XCTAssertNil(panel.list)
        XCTAssertTrue(panel.unsupported)
        XCTAssertNil(panel.error)
    }

    func testRevokeOfADeviceAlreadyGoneOnlyTidiesTheList() async throws {
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "DELETE" {
                return IsolatedTestHTTPReply(status: 404, data: Data(#"{"error":"연결된 기기를 찾을 수 없습니다","code":"device_not_found"}"#.utf8))
            }
            return IsolatedTestHTTPReply(status: 200, data: Data(Self.list.utf8))
        }
        defer { Task { await network.close() } }
        let api = network.makeAPIClient()
        let panel = DevicesPanel()
        await panel.attach(api)
        let device = try XCTUnwrap(panel.list?.devices.last)
        let done = await panel.revoke(device, api: api)
        XCTAssertTrue(done)
        XCTAssertEqual(panel.list?.devices.map(\.name), ["민수의 iPhone"])
        XCTAssertNil(panel.revokeError)

        // 다른 서버(다른 연결)로 바뀌면 앞 서버의 목록을 먼저 지운다.
        let other = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 503, data: Data(#"{"error":"서버를 시작하는 중입니다","code":"STARTING"}"#.utf8)) }
        defer { Task { await other.close() } }
        await panel.attach(other.makeAPIClient())
        XCTAssertNil(panel.list)
        XCTAssertEqual(panel.error, "서버를 시작하는 중입니다")
    }
}

private final class DevicesReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int
    private var body: String
    private var deleteCount = 0
    init(status: Int, body: String) { self.status = status; self.body = body }
    var reply: (Int, String) { lock.withLock { (status, body) } }
    var deletes: Int { lock.withLock { deleteCount } }
    func set(_ status: Int, _ body: String) { lock.withLock { self.status = status; self.body = body } }
    func deleted() { lock.withLock { deleteCount += 1 } }
}
