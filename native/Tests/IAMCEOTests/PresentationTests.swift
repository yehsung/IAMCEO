import XCTest
@testable import IAMCEO

final class PresentationTests: XCTestCase {
    func testObservationFailureKeepsLastStateAndDedicatedTimestamp() {
        let member = Member(status: "working", lastError: "지난 턴 오류", updatedAt: "new-db-time",
                            statusObservation: StatusObservation(source: "core", observedAt: "last-observation", freshness: "stale",
                                                                 ownership: "unknown", error: ObservationError(code: "timeout", note: "재관측 중")))
        let info = MemberStatusInfo(member)
        XCTAssertEqual(info.label, "상태 확인 불가")
        XCTAssertFalse(info.live)
        XCTAssertFalse(info.needsMe)
        XCTAssertEqual(MemberObservationInfo(member).lastStatus, "일하는 중")
        XCTAssertEqual(MemberObservationInfo(member).lastObservedAt, "last-observation")
        XCTAssertEqual(MemberObservationInfo(member).error, "재관측 중")
        XCTAssertNil(MemberObservationInfo(Member(updatedAt: "db-time")).lastObservedAt)
    }

    func testOnlyConfirmedApprovalIsCalledApproval() {
        for reason in [nil, "setup", "status_unknown", "future"] as [String?] {
            let info = MemberStatusInfo(Member(status: "blocked", blockedReason: reason))
            XCTAssertNotEqual(info.label, "승인 창 앞")
            XCTAssertFalse(info.needsMe)
        }
        for reason in ["permission", "selection"] {
            XCTAssertEqual(MemberStatusInfo(Member(status: "blocked", blockedReason: reason)).label, "승인 창 앞")
            XCTAssertTrue(MemberStatusInfo(Member(status: "blocked", blockedReason: reason)).needsMe)
        }
        XCTAssertEqual(MemberStatusInfo("blocked").label, "승인 창 앞") // Existing string initializer remains compatible.
        let conflict = MemberStatusInfo(Member(status: "idle", statusObservation: StatusObservation(ownership: "conflict")))
        XCTAssertTrue(conflict.needsMe)
        XCTAssertFalse(conflict.live)
        XCTAssertEqual(MemberStatusInfo(Member(status: "future-status")).label, "상태 확인 불가")
    }

    func testManualStatusAndLastReportDoNotUseUpdatedAt() {
        let member = Member(origin: "manual", status: "working", now: "지난 작업", next: "보존할 예정",
                            updatedAt: "unrelated-edit", nowAt: "report-time", manualActivityAt: "tool-time")
        XCTAssertTrue(MemberStatusInfo(member).label.contains("추정"))
        XCTAssertFalse(MemberStatusInfo(member).live)
        XCTAssertEqual(MemberObservationInfo(member).manualActivityAt, "tool-time")
        XCTAssertEqual(LastReportInfo(member).label, "마지막 보고")
        XCTAssertEqual(LastReportInfo(member).text, "지난 작업")
        XCTAssertEqual(LastReportInfo(member).reportedAt, "report-time")
        XCTAssertEqual(LastReportInfo(member).next, "보존할 예정")
        XCTAssertNil(LastReportInfo(Member(updatedAt: "db-time")).reportedAt)
        XCTAssertEqual(LastReportInfo(Member()).text, "아직 보고가 없습니다")
    }

    func testUncollectedSubagentsNeverInventZeroFromLegacyField() {
        XCTAssertNil(SubagentInfo(Member(subagents: 0)).count)
        XCTAssertNil(SubagentInfo(Member(subagents: 8)).count)
        XCTAssertEqual(SubagentInfo(Member(subagentState: SubagentState(quality: "exact", count: 0))).count, 0)
        XCTAssertTrue(SubagentInfo(Member(subagentState: SubagentState(quality: "estimated", count: 2))).label.contains("추정"))
        for quality in ["unknown", "unsupported", "future"] {
            XCTAssertNil(SubagentInfo(Member(subagentState: SubagentState(quality: quality, count: 10))).count)
        }
        XCTAssertNil(SubagentInfo(Member(subagentState: SubagentState(quality: "exact", count: -1))).count)
    }

    private func summary(needsOwner: Int = 0, checking: Int = 0, unknown: Int = 0) -> MemberDeliverySummary {
        MemberDeliverySummary(memberId: "m", undeliveredCount: 123, unknownCount: unknown, deliveringCount: 0,
                              checkingCount: checking, needsOwnerCount: needsOwner, waitingBehindCount: 100,
                              oldestAt: nil, reasons: [])
    }

    func testDeliveryAggregatesUseAllRowsAndOnlyNeedsOwnerCreatesAttention() {
        for value in [summary(checking: 123), summary(unknown: 10), summary()] {
            XCTAssertFalse(DeliveryInfo(value).needsOwner)
        }
        let info = DeliveryInfo(summary(needsOwner: 123, checking: 300))
        XCTAssertEqual(info.label, "전달 확인 99+")
        XCTAssertTrue(info.explanation.contains("123건"))
        XCTAssertTrue(info.needsOwner)
        XCTAssertEqual(DeliveryInfo.badgeCount(-1), "0")
        XCTAssertEqual(DeliveryInfo.badgeCount(99), "99")
        XCTAssertNil(DeliveryInfo(nil))
        XCTAssertEqual(DeliveryInfo("delivered")?.label, "받음")
        XCTAssertEqual(DeliveryInfo(DeliveryNoticeItem(id: "d", phase: .retryWait)).label, "자동 재전송 대기")
        XCTAssertEqual(DeliveryInfo(DeliveryNoticeItem(id: "d", status: "delivered", phase: .resolved)).label, "받음")
        XCTAssertNotEqual(DeliveryInfo(DeliveryNoticeItem(id: "d", status: "delivered", phase: .unknown)).label, "받음")
        XCTAssertTrue(DeliveryInfo(DeliveryNoticeItem(id: "d", phase: .stopped)).explanation.contains("알 수 없습니다"))
    }

    func testEvidenceAbsenceNeedsCompleteScanAndDoesNotMeanNotReceived() {
        func evidence(_ verdict: EvidenceVerdict, complete: Bool) -> DeliveryEvidence {
            DeliveryEvidence(source: "codex_jsonl", verdict: verdict, location: "private-path", code: "test", complete: complete, checkedAt: "time")
        }
        XCTAssertEqual(DeliveryEvidenceInfo(evidence(.present, complete: false)).label, "확인됨")
        XCTAssertEqual(DeliveryEvidenceInfo(evidence(.absent, complete: true)).label, "해당 없음")
        XCTAssertTrue(DeliveryEvidenceInfo(evidence(.absent, complete: true)).detail.contains("미수신을 확정하지 않습니다"))
        XCTAssertEqual(DeliveryEvidenceInfo(evidence(.absent, complete: false)).label, "취득 불가")
        XCTAssertEqual(DeliveryEvidenceInfo(evidence(.unknown, complete: true)).label, "취득 불가")
        let composer = DeliveryEvidenceInfo(DeliveryEvidence(source: "core_screen", verdict: .present, location: "composer", code: "draft_pending", complete: true, checkedAt: "time"))
        XCTAssertEqual(composer.sourceLabel, "입력칸")
        XCTAssertTrue(composer.detail.contains("받았다는 뜻은 아닙니다"))
    }

    func testFutureAndDuplicateDraftCannotAuthorizePhysicalInput() {
        var item = DeliveryNoticeItem(id: "d", deliveryId: "d", phase: .needsOwner, reason: "retry_exhausted",
                                      version: 2, allowedActions: [.recheck, .retryWithRisk, .stopRetry, .unknown, .recheck])
        XCTAssertEqual(deliveryPanelActions(item), [.recheck, .retryWithRisk, .stopRetry])
        item.reason = "future"
        XCTAssertEqual(deliveryPanelActions(item), [.recheck])
        item.reason = "duplicate_draft"
        XCTAssertEqual(deliveryPanelActions(item), [.recheck])
        item.reason = "session_lost"
        XCTAssertFalse(deliveryPanelActions(item).contains(.retryWithRisk))
        item.phase = .resolved
        XCTAssertTrue(deliveryPanelActions(item).isEmpty)
        item.reason = "retry_exhausted"; item.phase = .checking
        XCTAssertEqual(deliveryPanelActions(item), [.recheck])
        item.phase = .unknown
        XCTAssertEqual(deliveryPanelActions(item), [.recheck])
        item.version = 0
        XCTAssertTrue(deliveryPanelActions(item).isEmpty)
        item.version = 2; item.deliveryId = nil
        XCTAssertTrue(deliveryPanelActions(item).isEmpty)
    }
}
