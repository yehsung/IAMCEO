import Foundation

enum ConnectionStatus: String, Sendable { case disconnected, connecting, connected, demo, failed }
enum RealtimeStatus: String, Sendable { case paused, connecting, syncing, live, legacy, fallback, blocked }

/// 끊김·재시작·망 변화를 판정하는 근거와 규칙(값 타입 상태 기계).
/// 시계와 작업(Task), 화면이 읽는 값(showsOffline, isRestarting, isCheckingConnection, connectionIssue, connectionStatus)은
/// AppStore 가 쥔다(AppStore+Connection.swift). 이 타입은 시각을 직접 재지 않고 받은 시각으로만 판정한다.
struct ConnectionHealth {
    /// 연결하지 못한 읽기가 이어진 수와 그 첫 시각, 마지막 까닭(기록용).
    var transportFailures = 0
    var firstTransportFailure: Duration?
    var transportFailureReason = "transport"
    var retriedConsistencyFailure = false
    /// 직전 읽기 실패가 '서버가 답했지만 쓸 수 없는 응답'이었는가(연결 불가와 구분).
    var answeredFailure = false
    var offlineChangedAt: Duration?
    var restartDeadline: Duration?
    var restartWindowUsed = false
    var foregroundGraceUntil: Duration?
    var foregroundRetry = 0
    var pathWasSatisfied: Bool?
    var pathInterfaces: String?

    static func isConsistencyFailure(_ error: Error) -> Bool {
        if case SubmissionError.mismatchedResult = error { return true }
        return false
    }

    static func isUnreachable(_ error: Error) -> Bool {
        let transport: Set<URLError.Code> = [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
            .dnsLookupFailed, .timedOut, .internationalRoamingOff, .dataNotAllowed, .callIsActive]
        return [502, 503, 504].contains((error as? APIError)?.status ?? 0)
            || (error as? URLError).map { transport.contains($0.code) } == true
    }

    /// 이 Mac 안의 서버는 꺼졌다 켜지는 것을 빨리 따라가려고 3초까지만 물러난다. 다만 서버가 답은 하는데
    /// 읽기가 실패하는 동안(응답 해석 실패, 5xx)에는 3초마다 전체 읽기를 되풀이하지 않도록 원격과 같은 30초를 쓴다.
    func retryCap(host: String?) -> Double {
        ["127.0.0.1", "localhost", "::1"].contains(host ?? "") && !answeredFailure ? 3 : 30
    }

    mutating func recordTransportFailure(_ error: Error, at now: Duration) {
        transportFailures += 1
        if firstTransportFailure == nil { firstTransportFailure = now }
        transportFailureReason = (error as? URLError).map { "transport_\($0.code.rawValue)" }
            ?? "gateway_\((error as? APIError)?.status ?? 0)"
    }

    /// 끊김을 화면에 알릴 시각. 첫 실패에서 3초, 앞으로 돌아온 뒤의 유예, 살아 있는 소켓의 마지막 신호에서 20초,
    /// 끊김 표시를 막 거둔 뒤 2초 가운데 가장 늦은 때다. `healthySocketFrame`은 소켓이 건강할 때만 넘긴다.
    func offlineDeadline(from firstFailure: Duration, healthySocketFrame: Duration?, showsOffline: Bool) -> Duration {
        var deadline = firstFailure + .seconds(3)
        if let foregroundGraceUntil { deadline = max(deadline, foregroundGraceUntil) }
        if let healthySocketFrame { deadline = max(deadline, healthySocketFrame + .seconds(20)) }
        if !showsOffline, let offlineChangedAt { deadline = max(deadline, offlineChangedAt + .seconds(2)) }
        return deadline
    }

    /// 망 알림 하나를 반영한다. 끊겼던 길이 돌아왔는지(restored), 끊기지 않고 길만 바뀌었는지(rerouted)를 돌려준다.
    /// `interfaces`는 지금 쓸 수 있는 망 목록의 서명이다(Wi-Fi 전환, VPN 터널 복귀를 알아본다).
    mutating func notePath(satisfied: Bool, interfaces: String?) -> (restored: Bool, rerouted: Bool) {
        let restored = pathWasSatisfied == false && satisfied
        let rerouted = satisfied && pathWasSatisfied == true && interfaces != nil && pathInterfaces != nil && interfaces != pathInterfaces
        pathWasSatisfied = satisfied
        if satisfied, let interfaces { pathInterfaces = interfaces }
        return (restored, rerouted)
    }

    /// 실패한 읽기 뒤 다음 읽기까지 쉴 시간. 앞으로 돌아온 직후의 연결 실패는 짧게 세 번, 응답이 어긋난 것은 한 번만
    /// 0.5초 뒤, 나머지는 실패 수에 따라 두 배씩 늘려 `retryCap(host:)`까지.
    mutating func nextSyncRetryDelay(after error: Error, at now: Duration, restFailures: Int, host: String?) -> Duration {
        if Self.isUnreachable(error), let until = foregroundGraceUntil, now < until {
            let delay: Duration = [.milliseconds(300), .seconds(1), .seconds(2)][min(foregroundRetry, 2)]
            foregroundRetry += 1
            return delay
        }
        if !retriedConsistencyFailure, error as? RealtimeClientError == .invalidFrame || Self.isConsistencyFailure(error) {
            retriedConsistencyFailure = true
            return .milliseconds(500)
        }
        return .seconds(min(retryCap(host: host), max(1, pow(2, Double(min(restFailures - 1, 5))))))
    }
}
