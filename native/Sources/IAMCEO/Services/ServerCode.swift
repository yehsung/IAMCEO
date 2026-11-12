import Foundation

/// 서버가 문장 대신 주는 오류·보류 코드(서버의 shared/error-codes.ts). 앱은 동작을 이 코드로 가른다.
/// 코드를 싣지 않는 옛 서버(0.2.3 까지)에서는 예전처럼 문장으로 가른다. legacy 문장은 그 서버가 보내던 글 그대로다.
enum ServerCode {
    // 실행 엔진의 터미널 거절. 넓은 코드 TERMINAL_REFUSED 아래의 reason 으로 온다.
    static let terminalMissing = "core_terminal_missing"
    static let leaseRequired = "core_lease_required"
    static let leaseOther = "core_lease_other"
    static let terminalFinished = "core_terminal_finished"
    /// 작업 ID가 있는 터미널 조작에서 조작권이 끝났거나 바뀌었다. 응답의 code, 영수증의 reason 으로 온다.
    static let leaseExpired = "terminal_lease_expired"
    /// 대표 글의 전달 보류 중 '전달 여부를 확인할 수 없어 보류'. Message.deliveryCode 로 온다.
    static let deliveryUnknownHold = "held_delivery_unknown"

    static let legacyTerminalMissing = "No core terminal for member"
    static let legacyLeaseRequired = "A matching active terminal control lease is required"
    static let legacyLeaseExpired = "조작권이 만료되었거나 바뀌었습니다"
    private static let legacyLeaseGone = [legacyLeaseRequired, "Another terminal control lease is active",
                                          "Terminal has finished", legacyTerminalMissing, legacyLeaseExpired]
    private static let leaseGoneReasons: Set<String> = [leaseRequired, leaseOther, terminalFinished, terminalMissing, leaseExpired]

    /// 서버가 '이 팀장에게 core 터미널이 없다'고 거절했는가. reason 이 있으면 그것만 본다.
    static func terminalMissing(reason: String?, message: String?) -> Bool {
        if let reason { return reason == terminalMissing }
        return message?.contains(legacyTerminalMissing) == true
    }
    static func terminalMissing(_ error: Error?) -> Bool {
        guard let error else { return false }
        return terminalMissing(reason: (error as? APIError)?.reason, message: error.localizedDescription)
    }

    /// 이 기기의 조작권이 서버에 더는 없다는 거절인가(409 에서만 부른다).
    static func leaseGone(code: String?, reason: String?, message: String) -> Bool {
        if let reason { return leaseGoneReasons.contains(reason) }
        if code == leaseExpired { return true }
        return legacyLeaseGone.contains { message.contains($0) }
    }

    /// 놓으려던 조작권이 이미 서버에 없다(만료되었거나 다른 곳에서 놓였다). 놓기 요청의 목적이 이미 이뤄진 상태다.
    static func leaseAlreadyReleased(reason: String?, message: String) -> Bool {
        if let reason { return reason == leaseRequired }
        return message.contains(legacyLeaseRequired)
    }

    /// 작업 ID가 있는 놓기 요청이 '조작권이 만료되었거나 바뀌었다'로 거절되었다.
    static func leaseExpiredReceipt(_ receipt: OperationReceipt) -> Bool {
        if let reason = receipt.reason { return reason == leaseExpired }
        return receipt.error == legacyLeaseExpired
    }

    /// 대표 글이 '전달 여부를 확인할 수 없어' 보류되었는가. 그 뒤의 모든 전달을 막으므로 터미널을 확인해야 한다.
    static func deliveryUnknownHold(_ message: Message) -> Bool {
        guard message.delivery == "held" else { return false }
        if let code = message.deliveryCode { return code == deliveryUnknownHold }
        return (message.deliveryNote ?? "").hasPrefix("전달 여부를 확인할 수 없어")
    }
}

extension OperationReceipt {
    /// 영수증의 거절을 APIError 로. 코드와 좁은 사유를 그대로 옮긴다.
    func refusalError(status: Int = 409) -> APIError? {
        guard let error else { return nil }
        return APIError(status: status, message: error, code: code, reason: reason)
    }
}
