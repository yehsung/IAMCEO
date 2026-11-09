import Foundation
import XCTest
@testable import IAMCEO

final class PresentationTests: XCTestCase {
    @MainActor func testOfficeCountsMatchHomeClassificationIncludingUnavailableObservations() {
        var members = MemberStatusInfo.order.map { Member(id: $0, status: $0, blockedReason: $0 == "blocked" ? "permission" : nil) }
        for code in ["progress_stalled", "start_stalled", "timeout"] {
            for freshness in ["fresh", "stale", "unknown"] {
                members.append(Member(id: "\(code)-\(freshness)", status: "working", statusObservation:
                    StatusObservation(freshness: freshness, ownership: "verified", error: ObservationError(code: code, note: code))))
            }
        }
        members.append(Member(id: "conflict", status: "working", statusObservation: StatusObservation(freshness: "fresh", ownership: "conflict")))
        let home = MemberStatusInfo.summaryCounts(members)
        let office = OfficeView.counts(members)
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: office.map { ($0.status, $0.count) }), home)
        XCTAssertEqual(office.first { $0.status == "unknown" }?.label, "상태 확인 불가")
        XCTAssertEqual(office.first { $0.status == "idle" }?.label, "쉬는 중")
        XCTAssertEqual(office.reduce(0) { $0 + $1.count }, members.count)
        for member in members where MemberStatusInfo.isUncertain(member) {
            XCTAssertEqual(officeStateLabel(member), MemberStatusInfo(member).label)
        }
    }

    func testQuietRunAdvisoriesPreserveWorkingBadgeAndShareSummaryClassification() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for code in ["progress_stalled", "start_stalled"] {
            var member = Member(id: code, status: "working", statusObservation: StatusObservation(source: "core", freshness: "fresh", ownership: "verified",
                error: ObservationError(code: code, note: "technical diagnostic")))
            member.executionState = MemberExecutionState(runId: "run", inputReceivedAt: "2027-01-15T07:34:00Z", lastProgressAt: "2027-01-15T07:34:00Z")
            // Use a fixed baseline so the elapsed line can be asserted independently of wall time.
            let baseline = try XCTUnwrap(ISO8601DateFormatter().date(from: "2027-01-15T07:34:00Z"))
            XCTAssertEqual(MemberStatusInfo.progressNote(member, now: baseline.addingTimeInterval(30 * 60)), "화면 출력 없이 30분째 진행 중")
            XCTAssertEqual(MemberStatusInfo(member).label, "일하는 중")
            XCTAssertTrue(MemberStatusInfo(member).live)
            XCTAssertFalse(MemberStatusInfo.isUncertain(member))
            XCTAssertEqual(MemberStatusInfo.summaryCounts([member]), ["working": 1])
            XCTAssertFalse(MemberObservationInfo(member).error?.contains("technical") ?? true)
            for freshness in ["stale", "unknown", nil] as [String?] {
                var stale = member; stale.statusObservation?.freshness = freshness
                XCTAssertTrue(MemberStatusInfo.isUncertain(stale))
                XCTAssertEqual(MemberStatusInfo(stale).label, "상태 확인 불가")
                XCTAssertNil(MemberStatusInfo.progressNote(stale, now: now))
            }
            for ownership in ["unknown", "conflict", nil] as [String?] {
                var unowned = member; unowned.statusObservation?.ownership = ownership
                XCTAssertTrue(MemberStatusInfo.isUncertain(unowned))
                XCTAssertEqual(MemberStatusInfo.summaryCounts([member, unowned]), ["working": 1, "unknown": 1])
            }
        }
    }

    func testAllObservationFailureCodesRemainUncertainAndFolderTrustRemainsApproval() {
        let codes = ["unsupported_generation", "session_owned", "no_owned_terminal", "multiple_terminals", "ownership_changed",
                     "core_owner_conflict", "timeout", "protocol", "down", "closed", "rpc", "config", "unavailable", "unsupported",
                     "conflict", "stale", "not_found", "error", "status_unknown", "snapshot_failed", "disconnected", "future_failure"]
        for code in codes {
            let member = Member(status: "working", statusObservation: StatusObservation(freshness: "fresh", ownership: "verified", error: ObservationError(code: code, note: code)))
            XCTAssertTrue(MemberStatusInfo.isUncertain(member), code)
            XCTAssertEqual(MemberStatusInfo(member).label, "상태 확인 불가", code)
            XCTAssertEqual(MemberStatusInfo.summaryCounts([member]), ["unknown": 1], code)
        }
        let trust = Member(backend: "core", status: "blocked", blockedReason: "setup", statusObservation: StatusObservation(source: "core", freshness: "fresh", ownership: "verified", error: ObservationError(code: "folder_trust", note: "폴더 신뢰")))
        XCTAssertFalse(MemberStatusInfo.isUncertain(trust))
        XCTAssertEqual(MemberStatusInfo.summaryCounts([trust]), ["blocked": 1])
        XCTAssertEqual(MemberStatusInfo(trust).label, "승인 창 앞")
    }

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

    func testConfirmedAbsenceAndIdentityNotesUseServerEvidenceAndActions() {
        let note = "기록상 아직 안 들어갔습니다. 입력칸에 다른 글이 있어 자동으로 넣지 않았습니다."
        var item = DeliveryNoticeItem(id: "d", deliveryId: "d", status: "held", phase: .needsOwner,
                                     reason: "complete_range_without_marker", note: note, version: 2,
                                     evidence: [DeliveryEvidence(source: "codex_jsonl", verdict: .absent, location: "none",
                                                                 code: "complete_range_without_marker", complete: true, checkedAt: "time")],
                                     allowedActions: [.recheck, .retryWithRisk, .stopRetry])
        XCTAssertEqual(DeliveryInfo(item).explanation, note)
        XCTAssertTrue(deliveryPanelActions(item).contains(.retryWithRisk))
        item.reason = "identity_changed"; item.note = "세션이 다시 열려 이전 입력의 결과를 이어서 확인하지 못했습니다."
        XCTAssertEqual(DeliveryInfo(item).explanation, item.note)
        XCTAssertTrue(deliveryPanelActions(item).contains(.retryWithRisk))
        item.evidence = []
        XCTAssertFalse(deliveryPanelActions(item).contains(.retryWithRisk))
        item.reason = "not_received"; item.phase = .some(.none); item.note = "입력 전에 5회 거절되어 보류했습니다."
        XCTAssertEqual(DeliveryInfo(item).explanation, item.note)
    }

    func testFutureAndDuplicateDraftCannotAuthorizePhysicalInput() {
        var item = DeliveryNoticeItem(id: "d", deliveryId: "d", phase: .needsOwner, reason: "retry_exhausted",
                                      version: 2, allowedActions: [.recheck, .retryWithRisk, .stopRetry, .unknown, .recheck])
        XCTAssertEqual(deliveryPanelActions(item), [.recheck, .retryWithRisk, .stopRetry])
        item.reason = "future"
        XCTAssertEqual(deliveryPanelActions(item), [.recheck, .stopRetry])
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
    /// Real rehearsal screen (2026-11-07): the runner-down banner showed the raw socket error and CLI hint.
    func testRunnerDownDetailHidesTransportError() {
        var c = ProjectConnection(ok: false, reason: "backend_down", detail: "herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다 (hello: connect ENOENT /tmp/no-core.sock. Start herdr-core with /usr/bin/false server start)")
        XCTAssertEqual(c.ownerDetail, "herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다 · 원인은 실행 환경 보기에서 확인할 수 있습니다")
        c.detail = "herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다"
        XCTAssertEqual(c.ownerDetail, "herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다")
        c.reason = "archived"; c.detail = "보관된 프로젝트입니다 (보관함)"
        XCTAssertEqual(c.ownerDetail, "보관된 프로젝트입니다 (보관함)")
        c.detail = ""
        XCTAssertNil(c.ownerDetail)
    }
}


final class FriendlyErrorTests: XCTestCase {
    func testKnownProviderErrorsBecomePlainKorean() {
        XCTAssertTrue(friendlyError("Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew").contains("결제"))
        XCTAssertTrue(friendlyError("API Error: No response from API (waited 3m)").contains("응답하지 않습니다"))
        XCTAssertTrue(friendlyError("codex가 사용 한도 오류로 종료했습니다 (exit 1)").contains("사용 한도"))
        XCTAssertEqual(friendlyError("글을 넣었지만 턴이 시작되지 않았습니다"), "글을 넣었지만 일을 시작하지 않았습니다")
        XCTAssertEqual(friendlyError("세션이 끝났습니다 (exit_code=2)"), "세션이 끝났습니다 (종료 코드 2)")
    }

    func testUnknownErrorsPassThrough() {
        XCTAssertEqual(friendlyError("  알 수 없는 문제  "), "알 수 없는 문제")
    }
}

final class FriendlyLoadErrorTests: XCTestCase {
    func testChatHistoryFailuresUseKoreanAndUnknownErrorsHideInternalNames() {
        XCTAssertEqual(friendlyLoadError(ChatHistoryFailure.invalidPage),
                       "대화 기록을 확인하지 못했습니다. 다시 불러오기를 눌러 주세요.")
        XCTAssertEqual(friendlyLoadError(ChatHistoryFailure.storeChanged), "서버의 대화 기록이 변경되었습니다")
        enum UnknownFailure: Error { case unexpected }
        let raw = "작업을 완료할 수 없습니다.(IAMCEO.UnknownFailure 오류 0.)"
        let failures: [Error] = [UnknownFailure.unexpected, NSError(domain: "IAMCEO.UnknownFailure", code: 0),
                                 NSError(domain: "IAMCEO.UnknownFailure", code: 0, userInfo: [NSLocalizedDescriptionKey: raw]),
                                 APIError(status: 400, message: raw)]
        for error in failures {
            XCTAssertEqual(friendlyLoadError(error, what: "대화", verb: "읽지"), "대화를 읽지 못했습니다.")
        }
    }

    func testStatusCodesAndNetworkErrorsBecomeActionableKorean() {
        XCTAssertEqual(friendlyLoadError(APIError(status: 502, message: "Request failed (502).")),
                       "서버 문제로 원본을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
        XCTAssertEqual(friendlyLoadError(APIError(status: 404, message: "Request failed (404)."), what: "페이지"),
                       "페이지가 서버에 없습니다. 지워졌거나 옮겨졌을 수 있습니다.")
        XCTAssertEqual(friendlyLoadError(URLError(.networkConnectionLost), what: "자료", verb: "올리지"),
                       "서버와 연결이 끊겨 자료를 올리지 못했습니다.")
        XCTAssertEqual(friendlyLoadError(URLError(.timedOut), what: "승인 창", verb: "읽지"),
                       "시간이 너무 오래 걸려 승인 창을 읽지 못했습니다. 다시 시도해 주세요.")
        // A Korean message from the server is already for the CEO.
        XCTAssertEqual(friendlyLoadError(APIError(status: 400, message: "보관한 프로젝트입니다")), "보관한 프로젝트입니다")
        XCTAssertFalse(friendlyLoadError(APIError(status: 418, message: "I'm a teapot")).contains("teapot"))
    }

    func testParticlesFollowTheLastSyllable() {
        XCTAssertEqual(objectParticle("원본"), "을"); XCTAssertEqual(objectParticle("페이지"), "를")
        XCTAssertEqual(subjectParticle("첨부"), "가"); XCTAssertEqual(subjectParticle("파일"), "이")
    }
}

final class WaitReasonLabelTests: XCTestCase {
    func testReasonsReadPlainlyWithElapsedTime() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let tenMinutesAgo = ISO8601DateFormatter().string(from: now.addingTimeInterval(-600))
        XCTAssertEqual(waitReasonLabel("run_limit", since: tenMinutesAgo, used: 4, limit: 4, now: now),
                       "동시에 일하는 직원이 다 차서 차례를 기다리는 중(4/4) · 10분째")
        XCTAssertEqual(waitReasonLabel("waking", now: now), "깨우는 중")
        XCTAssertEqual(waitReasonLabel("member_busy", since: ISO8601DateFormatter().string(from: now.addingTimeInterval(-7300)), now: now),
                       "지금 하던 일이 끝나면 전달 · 2시간째")
        XCTAssertNil(waitReasonLabel(nil))
        XCTAssertEqual(waitReasonLabel("something_new", now: now), "전달을 기다리는 중")
        XCTAssertEqual(waitReasonTone("approval"), .attention)
        XCTAssertEqual(waitReasonTone("member_busy"), .neutral)
    }
}
