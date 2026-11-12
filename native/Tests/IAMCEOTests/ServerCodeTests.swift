import Foundation
import XCTest
@testable import IAMCEO

/// E9: 앱은 서버가 준 코드로 동작을 가르고, 코드가 없는 옛 서버에서는 예전처럼 문장으로 가른다.
final class ServerCodeTests: XCTestCase {
    func testTerminalMissingUsesReasonBeforeText() {
        XCTAssertTrue(ServerCode.terminalMissing(reason: "core_terminal_missing", message: "문구를 바꾼 거절"))
        // 코드가 있으면 문장에 옛 글이 들어 있어도 그 코드만 본다.
        XCTAssertFalse(ServerCode.terminalMissing(reason: "core_lease_required", message: "No core terminal for member"))
        // 옛 서버: 코드 없이 문장만 온다.
        XCTAssertTrue(ServerCode.terminalMissing(reason: nil, message: "No core terminal for member"))
        XCTAssertFalse(ServerCode.terminalMissing(reason: nil, message: "세션을 처리하는 중입니다"))
        XCTAssertTrue(ServerCode.terminalMissing(APIError(status: 409, message: "x", code: "TERMINAL_REFUSED", reason: "core_terminal_missing")))
        XCTAssertFalse(ServerCode.terminalMissing(nil))
    }

    func testLeaseGoneByReasonCodeOrLegacyText() {
        for reason in ["core_lease_required", "core_lease_other", "core_terminal_finished", "core_terminal_missing", "terminal_lease_expired"] {
            XCTAssertTrue(ServerCode.leaseGone(code: "TERMINAL_REFUSED", reason: reason, message: "다듬은 문장"), reason)
        }
        XCTAssertFalse(ServerCode.leaseGone(code: "TERMINAL_REFUSED", reason: "terminal_busy", message: "A matching active terminal control lease is required"))
        XCTAssertTrue(ServerCode.leaseGone(code: "terminal_lease_expired", reason: nil, message: "다듬은 문장"))
        XCTAssertFalse(ServerCode.leaseGone(code: "terminal_busy", reason: nil, message: "터미널 입력을 처리하는 중입니다"))
        // 옛 서버
        XCTAssertTrue(ServerCode.leaseGone(code: nil, reason: nil, message: "조작권이 만료되었거나 바뀌었습니다"))
        XCTAssertTrue(ServerCode.leaseGone(code: "TERMINAL_REFUSED", reason: nil, message: "Another terminal control lease is active"))
        XCTAssertFalse(ServerCode.leaseGone(code: "TERMINAL_REFUSED", reason: nil, message: "조작권이 없습니다"))
    }

    func testReceiptReasonDecodesAndDrivesLeaseExpiry() throws {
        let new = try JSONDecoder().decode(OperationReceipt.self, from: Data(#"{"operationId":"o1","kind":"terminal_control","status":"refused","code":"TERMINAL_REFUSED","error":"다듬은 문장","reason":"terminal_lease_expired"}"#.utf8))
        XCTAssertEqual(new.reason, "terminal_lease_expired")
        XCTAssertTrue(ServerCode.leaseExpiredReceipt(new))
        XCTAssertEqual(new.refusalError()?.reason, "terminal_lease_expired")
        let old = try JSONDecoder().decode(OperationReceipt.self, from: Data(#"{"operationId":"o2","kind":"terminal_control","status":"refused","code":"TERMINAL_REFUSED","error":"조작권이 만료되었거나 바뀌었습니다"}"#.utf8))
        XCTAssertNil(old.reason)
        XCTAssertTrue(ServerCode.leaseExpiredReceipt(old))
        let other = try JSONDecoder().decode(OperationReceipt.self, from: Data(#"{"operationId":"o3","kind":"terminal_control","status":"refused","code":"TERMINAL_REFUSED","error":"조작권이 만료되었거나 바뀌었습니다","reason":"session_generation_changed"}"#.utf8))
        XCTAssertFalse(ServerCode.leaseExpiredReceipt(other))
        // 저장했다 다시 읽어도 사유가 남는다(앱의 작업 기록).
        let round = try JSONDecoder().decode(OperationReceipt.self, from: JSONEncoder().encode(new))
        XCTAssertEqual(round.reason, "terminal_lease_expired")
    }

    func testDeliveryUnknownHoldUsesDeliveryCode() throws {
        func message(_ json: String) throws -> Message { try JSONDecoder().decode(Message.self, from: Data(json.utf8)) }
        let coded = try message(#"{"id":"a","delivery":"held","deliveryNote":"다듬은 보류 문장","deliveryCode":"held_delivery_unknown"}"#)
        XCTAssertEqual(coded.deliveryCode, "held_delivery_unknown")
        XCTAssertTrue(isDeliveryUnknownHold(coded))
        // 코드가 다른 보류면 문장이 옛 글로 시작해도 아니다.
        XCTAssertFalse(isDeliveryUnknownHold(try message(#"{"id":"b","delivery":"held","deliveryNote":"전달 여부를 확인할 수 없어 보류했습니다","deliveryCode":"held_asleep"}"#)))
        // 옛 서버: 코드 없이 문장 앞머리로.
        XCTAssertTrue(isDeliveryUnknownHold(try message(#"{"id":"c","delivery":"held","deliveryNote":"전달 여부를 확인할 수 없어 보류했습니다. 중복 실행 방지를 위해 자동 재전송하지 않습니다"}"#)))
        XCTAssertFalse(isDeliveryUnknownHold(try message(#"{"id":"d","delivery":"queued","deliveryCode":"held_delivery_unknown"}"#)))
        // 모르는 모양의 코드 칸이 와도 메시지는 읽힌다.
        XCTAssertNil(try message(#"{"id":"e","delivery":"held","deliveryCode":7}"#).deliveryCode)
    }

    /// 늦게 온 옛 판(rev 4, 잠듦 보류)을 새 판(rev 5, 전달 미확인 보류) 위에 합쳐도 문장과 코드가 같은 판에서 온다.
    func testMergingDeliveryKeepsCodeWithTheNewestRevision() throws {
        func message(_ json: String) throws -> Message { try JSONDecoder().decode(Message.self, from: Data(json.utf8)) }
        let newer = try message(#"{"id":"m1","projectId":"p","delivery":"held","deliveryNote":"전달 여부를 확인할 수 없어 보류했습니다","deliveryCode":"held_delivery_unknown","deliveryRevision":5}"#)
        let older = try message(#"{"id":"m1","projectId":"p","delivery":"held","deliveryNote":"잠든 팀장이라 보류했습니다","deliveryCode":"held_asleep","deliveryRevision":4}"#)
        let merged = older.mergingDelivery(from: newer)
        XCTAssertEqual(merged.deliveryRevision, 5)
        XCTAssertEqual(merged.deliveryNote, newer.deliveryNote)
        XCTAssertEqual(merged.deliveryCode, "held_delivery_unknown")
        XCTAssertTrue(isDeliveryUnknownHold(merged))
        // 반대로 풀린 판이 새것이면, 옛 판의 '전달 미확인' 코드가 남지 않는다.
        let released = try message(#"{"id":"m1","projectId":"p","delivery":"queued","deliveryNote":null,"deliveryRevision":6}"#)
        let stale = newer.mergingDelivery(from: released)
        XCTAssertNil(stale.deliveryCode)
        XCTAssertFalse(isDeliveryUnknownHold(stale))
        // 같은 판이면 새로 온 행(페이지)이 그대로다.
        XCTAssertEqual(newer.mergingDelivery(from: newer).deliveryCode, "held_delivery_unknown")
    }

    /// '그래도 재우기'는 코드로 가른다. 서버 문장에는 팀장 이름이 들어가서 '승인 창 정리' 같은 이름이면 문장 검사가 틀린다.
    func testSleepForceableUsesCodeBeforeText() {
        XCTAssertTrue(ServerCode.sleepForceable(code: "member_working", message: "승인 창 정리는 일하는 중입니다"))
        XCTAssertTrue(ServerCode.sleepForceable(code: "member_open_decision", message: "입력칸 개선에게 열린 결재가 있습니다"))
        XCTAssertTrue(ServerCode.sleepForceable(code: "member_queue_pending", message: "Queue is not empty"))
        for code in ["sleep_terminal_lease", "sleep_delivery_unknown", "sleep_compacting", "session_busy", "manual_session_unsupported"] {
            XCTAssertFalse(ServerCode.sleepForceable(code: code, message: "결제 연동은 일하는 중입니다"), code)
        }
        // 옛 서버(코드 없음)는 예전 문장 검사 그대로다.
        XCTAssertTrue(ServerCode.sleepForceable(code: nil, message: "결제 연동은 일하는 중입니다"))
        XCTAssertTrue(ServerCode.sleepForceable(code: nil, message: "결제 연동의 대기열이 남아 있습니다"))
        XCTAssertFalse(ServerCode.sleepForceable(code: nil, message: "승인 창 정리는 일하는 중입니다"))
        XCTAssertFalse(ServerCode.sleepForceable(code: nil, message: "직접 조작권이 남아 있어 잠재울 수 없습니다"))
    }

    /// 재우기 거절의 코드가 화면까지 온다(AppStore.sleepMemberOutcome).
    @MainActor func testSleepRefusalCarriesServerCode() async throws {
        let network = try IsolatedTestNetwork { request in
            let path = request.url!.path
            var status = 200, text = "{}"
            if path == "/api/bootstrap" { text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"# }
            else if path == "/api/projects/p/state" { text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"# }
            else if path.hasSuffix("/sleep") { status = 409; text = #"{"error":"승인 창 정리는 일하는 중입니다","code":"member_working"}"# }
            return IsolatedTestHTTPReply(status: status, data: Data(text.utf8))
        }
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "x"
        await store.connect(); store.setForeground(false)
        defer { store.disconnect() }
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","name":"승인 창 정리"}"#.utf8))
        let outcome = await store.sleepMemberOutcome(member)
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.refusal?.code, "member_working")
        XCTAssertTrue(ServerCode.sleepForceable(code: outcome.refusal?.code, message: store.errorMessage ?? ""))
    }

    /// 놓기 요청이 '조작권이 이미 없다'로 거절되면 놓기는 이미 이뤄진 것이다. 새 서버는 문장 대신 reason 으로 알린다.
    @MainActor func testReleaseRefusedByReasonCodeEndsLease() async throws {
        final class Reply: @unchecked Sendable {
            private let lock = NSLock(); private var value: (Int, String)?
            var terminal: (Int, String)? { get { lock.lock(); defer { lock.unlock() }; return value } set { lock.lock(); value = newValue; lock.unlock() } }
        }
        let reply = Reply()
        let network = try IsolatedTestNetwork { request in
            let path = request.url!.path
            var status = 200, text = "{}"
            if path == "/api/bootstrap" { text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"# }
            else if path == "/api/projects/p/state" { text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"# }
            else if path.hasSuffix("/terminal/control") {
                if let (s, body) = reply.terminal { status = s; text = body } else { text = #"{"leaseId":"L1","expiresAt":9999999999999}"# }
            }
            return IsolatedTestHTTPReply(status: status, data: Data(text.utf8))
        }
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "x"
        await store.connect(); store.setForeground(false)
        defer { store.disconnect() }
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","name":"카드 결제 구현"}"#.utf8))
        do { let r = await store.claimTerminal(member); XCTAssertTrue(r) }
        // 잠깐 바쁜 거절은 조작권을 지킨다.
        reply.terminal = (409, #"{"error":"세션을 처리하는 중입니다. 잠시 뒤 다시 여세요","code":"TERMINAL_REFUSED"}"#)
        do { let r = await store.terminalKey(member, key: "enter"); XCTAssertFalse(r) }
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "L1")
        // 문장을 다듬어도 사유 코드로 '조작권이 끝났다'를 안다.
        reply.terminal = (409, #"{"error":"다듬은 문장","code":"TERMINAL_REFUSED","reason":"core_lease_required"}"#)
        do { let r = await store.terminalKey(member, key: "enter"); XCTAssertFalse(r) }
        XCTAssertNil(store.terminalLeases["m"])
        reply.terminal = nil
        do { let r = await store.claimTerminal(member); XCTAssertTrue(r) }
        // 놓기 요청에 실행 엔진이 '조작권이 없다'고 하면 놓기가 이미 이뤄진 것이다.
        reply.terminal = (409, #"{"error":"다듬은 문장","code":"TERMINAL_REFUSED","reason":"core_lease_required"}"#)
        do { let r = await store.releaseTerminal(member); XCTAssertTrue(r) }
        XCTAssertNil(store.terminalLeases["m"])
        XCTAssertNil(store.errorMessage)
    }
}
