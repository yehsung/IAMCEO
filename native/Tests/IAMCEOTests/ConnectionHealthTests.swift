import Foundation
import XCTest
@testable import IAMCEO

/// E7: 끊김 판정 규칙을 AppStore 에서 값 타입(ConnectionHealth)으로 옮겼다. 옮기기 전의 판정을 그대로 고정한다.
final class ConnectionHealthTests: XCTestCase {
    func testUnreachableIsTransportOrGatewayAndConsistencyIsMismatchedResult() {
        XCTAssertTrue(ConnectionHealth.isUnreachable(URLError(.timedOut)))
        XCTAssertTrue(ConnectionHealth.isUnreachable(URLError(.notConnectedToInternet)))
        XCTAssertTrue(ConnectionHealth.isUnreachable(APIError(status: 503, message: "x")))
        XCTAssertFalse(ConnectionHealth.isUnreachable(APIError(status: 500, message: "x")))
        XCTAssertFalse(ConnectionHealth.isUnreachable(URLError(.badURL)))
        XCTAssertTrue(ConnectionHealth.isConsistencyFailure(SubmissionError.mismatchedResult))
        XCTAssertFalse(ConnectionHealth.isConsistencyFailure(URLError(.timedOut)))
    }

    func testRetryCapIsShortOnlyForThisMacWhileTheServerDoesNotAnswer() {
        var health = ConnectionHealth()
        XCTAssertEqual(health.retryCap(host: "127.0.0.1"), 3)
        XCTAssertEqual(health.retryCap(host: "my-mac.tail.ts.net"), 30)
        XCTAssertEqual(health.retryCap(host: nil), 30)
        health.answeredFailure = true
        XCTAssertEqual(health.retryCap(host: "localhost"), 30)
    }

    func testTransportFailureKeepsTheFirstTimeAndTheLastReason() {
        var health = ConnectionHealth()
        health.recordTransportFailure(URLError(.timedOut), at: .seconds(10))
        health.recordTransportFailure(APIError(status: 502, message: "x"), at: .seconds(12))
        XCTAssertEqual(health.transportFailures, 2)
        XCTAssertEqual(health.firstTransportFailure, .seconds(10))
        XCTAssertEqual(health.transportFailureReason, "gateway_502")
    }

    func testOfflineDeadlineIsTheLatestOfItsWaits() {
        var health = ConnectionHealth()
        XCTAssertEqual(health.offlineDeadline(from: .seconds(10), healthySocketFrame: nil, showsOffline: false), .seconds(13))
        health.foregroundGraceUntil = .seconds(15)
        XCTAssertEqual(health.offlineDeadline(from: .seconds(10), healthySocketFrame: nil, showsOffline: false), .seconds(15))
        XCTAssertEqual(health.offlineDeadline(from: .seconds(10), healthySocketFrame: .seconds(9), showsOffline: false), .seconds(29))
        health.offlineChangedAt = .seconds(40)
        XCTAssertEqual(health.offlineDeadline(from: .seconds(10), healthySocketFrame: nil, showsOffline: false), .seconds(42))
        XCTAssertEqual(health.offlineDeadline(from: .seconds(10), healthySocketFrame: nil, showsOffline: true), .seconds(15))
    }

    func testPathChangeSeesARestoredPathAndAChangedRouteOnly() {
        var health = ConnectionHealth()
        XCTAssertTrue(health.notePath(satisfied: true, interfaces: "en0:wifi|") == (false, false), "first report is a baseline")
        XCTAssertTrue(health.notePath(satisfied: true, interfaces: "en0:wifi|") == (false, false))
        XCTAssertTrue(health.notePath(satisfied: true, interfaces: "en0:wifi|utun4") == (false, true))
        XCTAssertTrue(health.notePath(satisfied: false, interfaces: nil) == (false, false))
        XCTAssertEqual(health.pathInterfaces, "en0:wifi|utun4", "an unsatisfied path keeps the last route")
        XCTAssertTrue(health.notePath(satisfied: true, interfaces: "en1:wired|") == (true, false))
        XCTAssertTrue(health.notePath(satisfied: true, interfaces: nil) == (false, false), "a loopback server reports no route")
    }

    func testSyncRetryDelayOrder() {
        var health = ConnectionHealth()
        health.foregroundGraceUntil = .seconds(5)
        let lost = URLError(.networkConnectionLost)
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(1), restFailures: 1, host: nil), .milliseconds(300))
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(2), restFailures: 2, host: nil), .seconds(1))
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(3), restFailures: 3, host: nil), .seconds(2))
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(4), restFailures: 4, host: nil), .seconds(2))
        XCTAssertEqual(health.foregroundRetry, 4)
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(6), restFailures: 4, host: nil), .seconds(8), "grace ended")
        XCTAssertEqual(health.nextSyncRetryDelay(after: SubmissionError.mismatchedResult, at: .seconds(7), restFailures: 1, host: nil),
                       .milliseconds(500))
        XCTAssertEqual(health.nextSyncRetryDelay(after: RealtimeClientError.invalidFrame, at: .seconds(8), restFailures: 1, host: nil),
                       .seconds(1), "a consistency failure is retried quickly only once")
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(9), restFailures: 9, host: "127.0.0.1"), .seconds(3))
        XCTAssertEqual(health.nextSyncRetryDelay(after: lost, at: .seconds(9), restFailures: 9, host: "remote"), .seconds(30))
    }
}
