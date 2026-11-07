import XCTest
@testable import IAMCEO

final class PresentationTests: XCTestCase {
    func testDemoHomeKeepsApprovalErrorAndOwnerDeliveryVisible() throws {
        let (_, state) = DemoFixtures.workspace(now: Date(timeIntervalSince1970: 1_800_000_000))
        for member in state.members {
            XCTAssertEqual(member.statusObservation?.freshness, "fresh", member.id)
            XCTAssertEqual(member.statusObservation?.ownership, "verified", member.id)
            XCTAssertNotNil(member.statusObservation?.observedAt, member.id)
            XCTAssertNil(member.statusObservation?.error, member.id)
            XCTAssertNotEqual(MemberStatusInfo(member).label, "상태 확인 불가", member.id)
        }
        let attention = HomeAttention(members: state.members, notices: state.deliveryNotices, messages: state.messages)
        XCTAssertEqual(attention.members.map { $0.member.id }, ["m-card", "m-funnel"])
        let card = try XCTUnwrap(attention.members.first?.member)
        XCTAssertEqual(MemberStatusInfo(card).label, "승인 창 앞")
        XCTAssertEqual(MemberStatusInfo(card).tone, .approval)
        XCTAssertEqual(MemberStatusInfo(attention.members[1].member).label, "오류")
        XCTAssertEqual(attention.failedMessages.map(\.id), ["x7"])
        let failed = try XCTUnwrap(attention.failedMessages.first)
        XCTAssertEqual(failed.body, "이탈 이벤트 이름부터 정리해 주세요.")
        XCTAssertEqual(failed.delivery, "failed")
        XCTAssertEqual(failed.deliveryNote, "자동 재시도로 해결 안 됨 → 대표 확인 필요")
        XCTAssertEqual(state.deliveryNotices?.version, 2)
        XCTAssertEqual(state.deliveryNotices?.members.first?.reasons.first?.code, "retry_exhausted")
    }

    func testHomeOnlyAddsFailedMessageWhenRecoveryNeedsOwner() {
        let member = Member(id: "m", status: "working")
        let failed = Message(id: "failed", mine: true, body: "지시", targetMemberId: "m", delivery: "failed")
        func attention(_ value: MemberDeliverySummary, messages: [Message] = [failed]) -> HomeAttention {
            HomeAttention(members: [member], notices: DeliveryNotices(version: 2, members: [value],
                          unassigned: UnassignedDeliverySummary(undeliveredCount: 0, unknownCount: 0, needsOwnerCount: 0)), messages: messages)
        }
        for value in [summary(checking: 123), summary(unknown: 10), summary()] {
            XCTAssertTrue(attention(value).failedMessages.isEmpty)
            XCTAssertTrue(attention(value).members.isEmpty)
        }
        XCTAssertEqual(attention(summary(needsOwner: 1)).failedMessages.map(\.id), [failed.id])
        let delivered = Message(id: "delivered", mine: true, body: "지시", targetMemberId: "m", delivery: "delivered")
        XCTAssertTrue(attention(summary(needsOwner: 1), messages: [failed, delivered]).failedMessages.isEmpty)
        XCTAssertTrue(HomeAttention(members: [member], notices: nil, messages: [failed]).failedMessages.isEmpty)
    }

    @MainActor func testDemoDeliveryStaysReadOnly() async {
        let store = AppStore(demo: true, persistCredentials: false)
        XCTAssertFalse(store.canWrite)
        XCTAssertFalse(store.uiCanWrite)
        guard let message = store.messages.first(where: { $0.id == "x7" }) else {
            return XCTFail("샘플 전달 실패 지시가 없습니다")
        }
        let sent = await store.resend(message)
        XCTAssertFalse(sent)
        XCTAssertEqual(store.messages.first(where: { $0.id == message.id })?.delivery, "failed")
    }

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
            var observed = Member(status: "blocked", blockedReason: reason,
                                  statusObservation: StatusObservation(source: "herdr", observedAt: "observed", freshness: "fresh",
                                                                       ownership: "verified", consecutiveFailures: 0))
            XCTAssertEqual(MemberStatusInfo(observed).label, "승인 창 앞")
            XCTAssertTrue(MemberStatusInfo(observed).needsMe)
            observed.statusObservation?.freshness = "stale"
            observed.statusObservation?.ownership = "unknown"
            observed.statusObservation?.error = ObservationError(code: "disconnected", note: "연결 끊김")
            XCTAssertEqual(MemberStatusInfo(observed).label, "상태 확인 불가")
            XCTAssertFalse(MemberStatusInfo(observed).needsMe)
        }
        XCTAssertEqual(MemberStatusInfo("blocked").label, "승인 창 앞") // Existing string initializer remains compatible.
        let conflict = MemberStatusInfo(Member(status: "idle", statusObservation: StatusObservation(ownership: "conflict")))
        XCTAssertTrue(conflict.needsMe)
        XCTAssertFalse(conflict.live)
        XCTAssertEqual(MemberStatusInfo(Member(status: "future-status")).label, "상태 확인 불가")
    }

    func testCoreFolderTrustReusesApprovalInInboxAndHomeOnlyWithVerifiedEvidence() {
        let observation = StatusObservation(source: "core", observedAt: "observed", freshness: "fresh", ownership: "verified",
                                            error: ObservationError(code: "folder_trust", note: "폴더 신뢰 확인 창에서 멈췄습니다: /fixture"))
        let member = Member(id: "trust", backend: "core", status: "blocked", paneId: "t1", blockedReason: "setup", statusObservation: observation)
        XCTAssertTrue(member.canReadCLIApproval)
        XCTAssertEqual(MemberStatusInfo(member).tone, .approval)
        XCTAssertTrue(MemberStatusInfo(member).needsMe)
        XCTAssertEqual(HomeAttention(members: [member], notices: nil, messages: []).members.map { $0.member.id }, ["trust"])
        for change in ["stale", "unknown", "otherError", "otherSource", "otherBackend", "working", "noPane"] {
            var other = member
            switch change {
            case "stale": other.statusObservation?.freshness = "stale"
            case "unknown": other.statusObservation?.ownership = "unknown"
            case "otherError": other.statusObservation?.error = ObservationError(code: "status_unknown", note: "알 수 없는 창")
            case "otherSource": other.statusObservation?.source = "herdr"
            case "otherBackend": other.backend = "herdr"
            case "working": other.status = "working"
            default: other.paneId = nil
            }
            XCTAssertFalse(other.canReadCLIApproval, change)
            if change != "noPane" { XCTAssertNotEqual(MemberStatusInfo(other).tone, .approval, change) }
        }
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

    func testHomeDeliverySummaryOmitsZeroCountsAndOwnerConfirmation() {
        func value(unknown: Int = 0, undelivered: Int = 0, waitingBehind: Int = 0) -> MemberDeliverySummary {
            MemberDeliverySummary(memberId: "m", undeliveredCount: undelivered, unknownCount: unknown,
                                  deliveringCount: 3, checkingCount: 4, needsOwnerCount: 1,
                                  waitingBehindCount: waitingBehind, oldestAt: nil, reasons: [])
        }
        XCTAssertEqual(homeDeliverySummary(value(undelivered: 1)), "미전달 1")
        XCTAssertEqual(homeDeliverySummary(value(unknown: 2)), "미확인 2")
        XCTAssertEqual(homeDeliverySummary(value(waitingBehind: 3)), "뒤에서 대기 3")
        XCTAssertEqual(homeDeliverySummary(value(unknown: 2, undelivered: 1)), "미확인 2 · 미전달 1")
        XCTAssertEqual(homeDeliverySummary(value(unknown: 2, waitingBehind: 3)), "미확인 2 · 뒤에서 대기 3")
        XCTAssertEqual(homeDeliverySummary(value(undelivered: 1, waitingBehind: 3)), "미전달 1 · 뒤에서 대기 3")
        XCTAssertEqual(homeDeliverySummary(value(unknown: 2, undelivered: 1, waitingBehind: 3)),
                       "미확인 2 · 미전달 1 · 뒤에서 대기 3")
        XCTAssertNil(homeDeliverySummary(value()))
        XCTAssertNil(homeDeliverySummary(value(unknown: -1, undelivered: -2, waitingBehind: -3)))
        XCTAssertEqual(homeDeliverySummary(value(unknown: -1, undelivered: 123, waitingBehind: -3)), "미전달 123")

        // Compact Home copy must not remove the full detail's owner-confirmation information.
        XCTAssertEqual(DeliveryInfo(value(undelivered: 1)).label, "전달 확인 1")
        XCTAssertEqual(DeliveryInfo(value(undelivered: 1)).explanation, "전달 확인이 필요한 항목 1건입니다.")
        XCTAssertTrue(DeliveryInfo(value()).needsOwner)
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
