import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO
#if os(macOS)
import AppKit
#endif

private actor UXChatAroundGate {
    private var pending: TestDeadlineContinuation<[Message], Error>?
    private var observers: [TestDeadlineContinuation<Void, Never>] = []

    func fetch() async throws -> [Message] {
        try await withThrowingTestDeadline { continuation in
            pending = continuation
            observers.forEach { $0.resume() }; observers = []
        }
    }
    func waitForRequest() async {
        if pending != nil { return }
        await withTestDeadline(fallback: ()) { observers.append($0) }
    }
    func respond(_ rows: [Message]) { pending?.resume(returning: rows); pending = nil }
}

@MainActor final class UXChatTests: XCTestCase {
    #if os(macOS)
    func testSharedCardLayoutWrapsChipsAndKeepsEmptyRowsEmpty() {
        func height(width: CGFloat) -> CGFloat {
            NSHostingView(rootView: ChipFlow(spacing: 6) {
                Color.clear.frame(width: 80, height: 20)
                Color.clear.frame(width: 80, height: 30)
            }.frame(width: width)).fittingSize.height
        }
        XCTAssertEqual(height(width: 100), 56, accuracy: 1)
        XCTAssertEqual(height(width: 200), 30, accuracy: 1)
        let empty = NSHostingView(rootView: ChipFlow(spacing: 6) { EmptyView() }.frame(width: 100))
        XCTAssertEqual(empty.fittingSize.height, 0, accuracy: 1)
    }

    func testSharedErrorLineWrapsAndUsesPresentationErrorText() {
        func size(_ text: String, width: CGFloat) -> CGSize {
            NSHostingView(rootView: ErrorLine(text: text).frame(width: width)).fittingSize
        }
        let raw = "exit 1"
        XCTAssertEqual(size(raw, width: 180), size(friendlyError(raw), width: 180))
        let long = String(repeating: "연결을 확인하고 다시 시도해 주세요. ", count: 5)
        XCTAssertGreaterThan(size(long, width: 180).height, size(long, width: 600).height)
    }
    #endif

    private func key(scope: MessageScope = .project, archived: Bool = false) -> ChatHistoryKey {
        ChatHistoryKey(namespace: "fixture", connectionGeneration: UUID(), projectID: "p", scope: scope, archived: archived)
    }
    private func row(_ id: String, member: String = "m", at: String = "2026-11-09T00:00:00Z") -> Message {
        Message(id: id, projectId: "p", at: at, memberId: member)
    }

    func testWaitReasonUsesSharedLabelElapsedAndRunLimit() throws {
        let now = try XCTUnwrap(parseISODate("2026-11-09T00:03:00Z"))
        let info = MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: "run_limit",
                                       waitingSince: "2026-11-09T00:00:00Z", runLimit: DeliveryRunLimit(used: 4, limit: 4))
        let message = Message(mine: true, deliveryInfo: [info], delivery: "queued")
        let line = try XCTUnwrap(ChatDeliveryWait.lines(message, target: Member(id: "m")).first)
        XCTAssertEqual(line.label(now: now), waitReasonLabel("run_limit", since: info.waitingSince, used: 4, limit: 4, now: now))
        XCTAssertTrue(line.label(now: now)?.contains("4/4") == true)
        XCTAssertTrue(line.label(now: now)?.contains("3분째") == true)
        XCTAssertTrue(line.label(now: now.addingTimeInterval(60))?.contains("4분째") == true)
        XCTAssertEqual(waitReasonTone(line.reason), .neutral)
    }

    func testEveryWaitReasonAndFutureReasonRemainVisibleWithoutRawDeliveryNote() {
        for reason in ["run_limit", "member_busy", "waking", "receipt_check", "approval", "manual_control", "runner_off", "archived", "unknown", "future_reason"] {
            let message = Message(mine: true, deliveryInfo: [MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: reason)], delivery: "held")
            let lines = ChatDeliveryWait.lines(message, target: nil)
            XCTAssertEqual(lines.count, 1, reason)
            XCTAssertEqual(lines.first?.label(), waitReasonLabel(reason))
        }
    }

    func testReceiptCheckRemainsVisibleWhileDeliveringAndWithOptionalLegacyState() {
        let info = MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: "receipt_check")
        for delivery in [Optional("delivering"), nil] {
            let message = Message(mine: true, deliveryInfo: [info], delivery: delivery)
            XCTAssertEqual(ChatDeliveryWait.lines(message, target: Member(id: "m")).first?.label(), waitReasonLabel("receipt_check"))
        }
    }

    func testWaitReasonTargetsActualRecipientAndRetainsMultipleDeliveries() {
        let message = Message(mine: true, deliveryInfo: [
            MessageDeliveryInfo(deliveryId: "other", memberId: "lead", waitReason: "approval"),
            MessageDeliveryInfo(deliveryId: "d1", memberId: "m", waitReason: "receipt_check"),
            MessageDeliveryInfo(deliveryId: "d2", memberId: "m", waitReason: "member_busy")
        ], delivery: "queued")
        XCTAssertEqual(ChatDeliveryWait.lines(message, target: Member(id: "m")).map(\.reason), ["receipt_check", "member_busy"])
        XCTAssertEqual(ChatDeliveryWait.lines(message, target: nil).count, 3)
    }

    func testLifecycleWakeFallbackAndNoDuplicateWakeReason() {
        for phase in ["starting", "starting_unknown", "reconnecting"] {
            let target = Member(id: "m", lifecycleState: MemberLifecycleState(operationId: "op", phase: phase))
            var message = Message(mine: true, delivery: "queued")
            XCTAssertEqual(ChatDeliveryWait.lines(message, target: target).first?.label(), "깨우는 중")
            message.deliveryInfo = [MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: "waking")]
            XCTAssertEqual(ChatDeliveryWait.lines(message, target: target).count, 1)
            for delivery in ["delivered", "sent", "failed"] {
                message.delivery = delivery
                XCTAssertTrue(ChatDeliveryWait.lines(message, target: target).isEmpty)
            }
            message.delivery = "queued"; message.mine = false
            XCTAssertTrue(ChatDeliveryWait.lines(message, target: target).isEmpty)
        }
        let ready = Member(id: "m", lifecycleState: MemberLifecycleState(operationId: "op", phase: "started_confirmed"))
        XCTAssertTrue(ChatDeliveryWait.lines(Message(mine: true, delivery: "queued"), target: ready).isEmpty)
    }

    func testCorrectionChainShowsBothDirectionsAndKeepsOriginal() {
        let original = Message(id: "a", title: "앞 보고", supersededBy: "b")
        let corrected = Message(id: "b", supersedes: "a", supersededBy: "c")
        XCTAssertEqual(chatReportCorrections(original).map(\.title), ["정정됨 · 최신 보고 보기"])
        XCTAssertEqual(chatReportCorrections(original).map(\.messageID), ["b"])
        XCTAssertEqual(chatReportCorrections(corrected).map(\.title), ["정정됨 · 최신 보고 보기", "앞 보고 정정"])
        XCTAssertEqual(chatReportCorrections(corrected).map(\.messageID), ["c", "a"])
        XCTAssertEqual(original.title, "앞 보고")
        XCTAssertTrue(chatReportCorrections(Message(id: "x", supersedes: "x", supersededBy: "")).isEmpty)
    }

    func testAllReportFilesIncludingLegacyFirstFileAreReachableInOrder() {
        XCTAssertEqual(chatReportFileIDs(Message(fileId: "legacy")), ["legacy"])
        XCTAssertEqual(chatReportFileIDs(Message(fileId: "a", fileIds: ["a", "b", "c", "b", ""])), ["a", "b", "c"])
        XCTAssertEqual(chatReportFileIDs(Message(fileId: "legacy", fileIds: ["a", "b"])), ["a", "b", "legacy"])
        let unicode = chatReportFileIDs(Message(fileIds: ["é", "e\u{301}"]))
        XCTAssertEqual(unicode.map { Data($0.utf8) }, [Data("é".utf8), Data("e\u{301}".utf8)])
    }

    func testRenderedContentInvalidatesForCorrectionFilesAndWaitChanges() {
        let original = Message(id: "m", fileIds: ["a"], deliveryInfo: [MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: "run_limit", runLimit: DeliveryRunLimit(used: 4, limit: 4))])
        var changed = original
        XCTAssertEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed.fileIds.append("b")
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed = original; changed.supersededBy = "corrected"
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed = original; changed.supersedes = "previous"
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed = original; changed.deliveryInfo?[0].runLimit = DeliveryRunLimit(used: 3, limit: 4)
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed = original; changed.deliveryInfo?[0].waitingSince = "2026-11-09T00:00:00Z"
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
        changed = original; changed.deliveryInfo?[0].waitReason = "receipt_check"
        XCTAssertNotEqual(ChatThreadContent(items: [original]), ChatThreadContent(items: [changed]))
    }

    func testRecipientBadgeUsesObservationAndEstimateWithoutLiveAnimation() {
        let stale = Member(id: "m", status: "working", statusObservation: StatusObservation(freshness: "stale", ownership: "verified"))
        let manual = Member(id: "m", origin: "manual", status: "working")
        let conflict = Member(id: "m", status: "working", statusObservation: StatusObservation(freshness: "fresh", ownership: "conflict"))
        for member in [stale, manual, conflict] {
            let info = MemberStatusInfo(member), badge = StatusBadge(member: member)
            XCTAssertEqual(badge.info.label, info.label)
            XCTAssertEqual(badge.info.tone, info.tone)
            XCTAssertFalse(badge.info.live)
            XCTAssertNotEqual(info.label, MemberStatusInfo(member.status).label)
        }
        XCTAssertTrue(MemberStatusInfo(manual).label.contains("추정"))
        XCTAssertEqual(MemberStatusInfo(stale).label, "상태 확인 불가")
    }

    func testLoadedMessageFocusDoesNotFetchOrReplaceContiguousHistory() async {
        let focus = ChatMessageFocus(), rows = [row("a"), row("b")]
        await focus.open("a", key: key(), available: rows) { throw URLError(.unsupportedURL) }
        XCTAssertEqual(focus.messageID, "a")
        XCTAssertNil(focus.context)
        XCTAssertNil(focus.error)
        XCTAssertFalse(focus.loading)
    }

    func testChangingRecipientClearsOpenedMessageFocusAndSameRecipientKeepsIt() async {
        let router = Router(destination: .chat), focus = ChatMessageFocus(), message = row("report")
        router.openChat("m"); router.chatMessageID = message.id
        await focus.open(message.id, key: key(scope: .member(memberId: "m")), available: [message]) {
            XCTFail("A loaded report must not fetch")
            return []
        }
        XCTAssertEqual(focus.messageID, message.id)
        router.chatTarget = "m"
        XCTAssertEqual(router.chatMessageID, message.id)
        for target in ["other", nil, "m"] as [String?] {
            router.chatMessageID = message.id
            router.chatTarget = target
            XCTAssertNil(router.chatMessageID)
            XCTAssertNil(focus.error)
        }
    }

    func testRecipientIdentityUsesBytesAndOpenChatThenMessageIDStillWorks() {
        let router = Router()
        router.openChat("é"); router.chatMessageID = "old"
        router.chatTarget = "e\u{301}"
        XCTAssertNil(router.chatMessageID)
        for target in ["e\u{301}", "other", nil] as [String?] {
            router.openChat(target)
            XCTAssertNil(router.chatMessageID)
            router.chatMessageID = "new"
            XCTAssertEqual(router.chatMessageID, "new")
            XCTAssertEqual(router.chatTarget, target)
            XCTAssertEqual(router.destination, .chat)
        }
    }

    func testProjectAndConnectionChangesClearFocusEvenWithProjectRecipient() {
        let router = Router(destination: .chat)
        for target in [nil, "m"] as [String?] {
            router.openChat(target); router.chatMessageID = "old-project"
            router.resetForProjectChange()
            XCTAssertNil(router.chatMessageID)
            XCTAssertNil(router.chatTarget)
            router.openChat(target); router.chatMessageID = "old-connection"
            router.resetForConnectionChange()
            XCTAssertNil(router.chatMessageID)
            XCTAssertNil(router.chatTarget)
        }
    }

    func testProjectResetClearsOldFocusAndAppliesNewNotificationFocus() {
        let router = Router(destination: .chat)
        router.openChat("old"); router.chatMessageID = "old-report"
        let route = NotificationRoute(target: .chat(projectId: "new-project", memberId: "worker", messageId: "new-report"),
                                      chatTarget: "worker", chatMessageID: "new-report")
        router.applyNotification(route, afterProjectChange: true, resetRevision: router.projectResetRevision)
        router.resetForProjectChange()
        XCTAssertEqual(router.chatTarget, "worker")
        XCTAssertEqual(router.chatMessageID, "new-report")
        router.resetForProjectChange()
        XCTAssertNil(router.chatMessageID)
    }

    func testOutOfScopeReportAndInstructionOpenInTheirConversation() async throws {
        let members = [Member(id: "lead", kind: "conductor"), Member(id: "worker"), Member(id: "other")]
        let messages = [row("report", member: "worker"),
                        Message(id: "instruction", projectId: "p", mine: true, memberId: "lead", targetMemberId: "worker")]
        for message in messages {
            for archived in [false, true] {
                let router = Router(destination: .chat), focus = ChatMessageFocus()
                router.openChat("other"); router.chatMessageID = message.id
                var historyKey = key(scope: .member(memberId: "other"))
                historyKey.archived = archived
                let rows = [message, row("unrelated", member: "other"), message]
                let destination = await focus.open(message.id, key: historyKey, available: [], members: members) { rows }
                XCTAssertEqual(destination, .member(memberId: "worker"))
                XCTAssertNil(focus.error)
                XCTAssertNil(focus.context)
                XCTAssertFalse(focus.loading)
                guard case .member(let memberID) = try XCTUnwrap(destination) else { return XCTFail("Expected a worker conversation") }
                router.openChat(memberID); router.chatMessageID = message.id
                let reopened = ChatMessageFocus()
                var destinationKey = key(scope: .member(memberId: memberID))
                destinationKey.archived = archived
                let nextDestination = await reopened.open(message.id, key: destinationKey, available: [], members: members) { rows }
                XCTAssertNil(nextDestination)
                XCTAssertEqual(router.chatMessageID, message.id)
                XCTAssertEqual(reopened.messageID, message.id)
                XCTAssertEqual(reopened.context?.map(\.id), [message.id])
                XCTAssertNil(reopened.error)
            }
        }
    }

    func testOutOfScopeLeadAndUnassignedMessagesOpenProjectConversation() async {
        let members = [Member(id: "root", kind: "root"), Member(id: "lead", kind: "conductor")]
        for message in [row("root-report", member: "root"), row("lead-report", member: "lead"),
                        Message(id: "project", projectId: "p"), row("removed-member", member: "removed")] {
            let focus = ChatMessageFocus()
            let destination = await focus.open(message.id, key: key(scope: .member(memberId: "other")),
                                               available: [], members: members) { [message] }
            XCTAssertEqual(destination, .project)
            XCTAssertNil(focus.error)
            let nextDestination = await focus.open(message.id, key: key(), available: [], members: members) { [message] }
            XCTAssertNil(nextDestination)
            XCTAssertEqual(focus.messageID, message.id)
            XCTAssertNil(focus.error)
        }
    }

    func testRelatedFileRoutePassesTheExactReportToFocus() async throws {
        let router = Router(destination: .files, usesPhoneNavigation: false)
        let report = row("report", member: "worker")
        FileLinks.openRelated(report, router: router)
        XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "worker")
        let id = try XCTUnwrap(router.chatMessageID), focus = ChatMessageFocus()
        await focus.open(id, key: key(scope: .member(memberId: "worker")), available: [report]) { throw URLError(.unsupportedURL) }
        XCTAssertEqual(focus.messageID, report.id)
        XCTAssertNil(focus.error)
    }

    func testAcceptedMemberMessageRouteDoesNotReusePreviousRecipient() async throws {
        let router = Router(destination: .team, usesPhoneNavigation: false)
        router.chatTarget = "previous"
        let accepted = ComposerAcceptedMessage(namespace: "fixture", projectID: "p", targetMemberID: "worker", messageID: "sent")
        accepted.open(in: router)
        XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "worker")
        let id = try XCTUnwrap(router.chatMessageID), focus = ChatMessageFocus()
        let message = Message(id: "sent", projectId: "p", mine: true, targetMemberId: "worker", delivery: "queued")
        await focus.open(id, key: key(scope: .member(memberId: "worker")), available: [message]) { throw URLError(.unsupportedURL) }
        XCTAssertEqual(focus.messageID, "sent")
        XCTAssertNil(focus.error)
    }

    func testMissingMessageAroundFiltersScopeSortsAndLeavesCursorUntouched() async throws {
        let historyKey = key(scope: .member(memberId: "m"))
        var history = ChatHistory(key: historyKey)
        let request = try XCTUnwrap(history.begin(.initial))
        let latest = row("z")
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: historyKey.scope, items: [latest], nextCursor: "opaque", hasOlder: true), request: request))
        let focus = ChatMessageFocus(), anchor = row("a"), before = row("0"), unrelated = row("other", member: "other")
        await focus.open("a", key: historyKey, available: history.items) { [anchor, unrelated, before, anchor] }
        XCTAssertEqual(focus.context?.map(\.id), ["0", "a"])
        XCTAssertEqual(focus.messageID, "a")
        XCTAssertEqual(history.items.map(\.id), ["z"])
        XCTAssertEqual(history.nextCursor, "opaque")
        XCTAssertTrue(history.hasOlder)
    }

    func testAroundCanFollowCorrectionInsideContextAndReturnToLoadedRange() async {
        let focus = ChatMessageFocus(), a = row("a"), b = row("b"), latest = row("z")
        await focus.open("a", key: key(), available: [latest]) { [a, b] }
        await focus.open("b", key: key(), available: [latest]) { throw URLError(.unsupportedURL) }
        XCTAssertEqual(focus.messageID, "b")
        XCTAssertEqual(focus.context?.count, 2)
        await focus.open("z", key: key(), available: [latest]) { throw URLError(.unsupportedURL) }
        XCTAssertEqual(focus.messageID, "z")
        XCTAssertNil(focus.context)
        XCTAssertNil(focus.error)
    }

    func testAroundRejectsMissingAnchorWrongProjectAndOversizedResponse() async {
        let foreign = Message(id: "a", projectId: "other", memberId: "m")
        let missing = row("b")
        for rows in [[foreign], [missing], [row("a"), foreign], Array(repeating: row("a"), count: 101)] {
            let focus = ChatMessageFocus()
            let destination = await focus.open("a", key: key(scope: .member(memberId: "m")), available: []) { rows }
            XCTAssertNil(destination)
            XCTAssertNil(focus.messageID)
            XCTAssertNil(focus.context)
            XCTAssertNotNil(focus.error)
            XCTAssertFalse(focus.loading)
            XCTAssertEqual(focus.error, rows.first?.id == "b" ? "이 글은 다른 대화에 있습니다"
                           : "대화 기록을 확인하지 못했습니다. 다시 불러오기를 눌러 주세요.")
        }
    }

    func testClearedAndCancelledFocusCannotRedirectLateOutOfScopeResponse() async {
        for cancel in [false, true] {
            let focus = ChatMessageFocus(), gate = UXChatAroundGate()
            let historyKey = key(scope: .member(memberId: "m")), outside = row("old", member: "other")
            let members = [Member(id: "other")]
            let task = Task { await focus.open("old", key: historyKey, available: [], members: members) { try await gate.fetch() } }
            await gate.waitForRequest()
            if cancel { task.cancel() } else { focus.clear() }
            await gate.respond([outside])
            let destination = await task.value
            XCTAssertNil(destination)
            XCTAssertNil(focus.messageID)
            XCTAssertNil(focus.context)
            XCTAssertNil(focus.error)
            XCTAssertFalse(focus.loading)
        }
    }

    func testBinaryAnchorIdentityDoesNotConfuseEquivalentUnicode() async {
        let focus = ChatMessageFocus(), composed = row("é"), decomposed = row("e\u{301}")
        await focus.open(decomposed.id, key: key(), available: [composed]) { [composed, decomposed] }
        XCTAssertEqual(focus.context?.count, 2)
        XCTAssertEqual(focus.messageID.map { Data($0.utf8) }, Data(decomposed.id.utf8))
    }

    func testLeavingContextAndNewDestinationIgnoreLateAroundResponse() async {
        for clear in [true, false] {
            let focus = ChatMessageFocus(), gate = UXChatAroundGate(), historyKey = key()
            let old = row("old"), current = row("current")
            let task = Task { await focus.open("old", key: historyKey, available: []) { try await gate.fetch() } }
            await gate.waitForRequest()
            XCTAssertTrue(focus.loading)
            if clear { focus.clear() }
            else { await focus.open("current", key: historyKey, available: [current]) { throw URLError(.unsupportedURL) } }
            await gate.respond([old])
            let destination = await task.value
            XCTAssertNil(destination)
            XCTAssertEqual(focus.messageID, clear ? nil : "current")
            XCTAssertNil(focus.context)
            XCTAssertNil(focus.error)
            XCTAssertFalse(focus.loading)
        }
    }

    func testCancelledAroundDoesNotPublishContextOrAnError() async {
        let focus = ChatMessageFocus(), gate = UXChatAroundGate(), historyKey = key(), anchor = row("a")
        let task = Task { await focus.open("a", key: historyKey, available: []) { try await gate.fetch() } }
        await gate.waitForRequest()
        task.cancel()
        await gate.respond([anchor])
        let destination = await task.value
        XCTAssertNil(destination)
        XCTAssertNil(focus.messageID)
        XCTAssertNil(focus.context)
        XCTAssertNil(focus.error)
        XCTAssertFalse(focus.loading)
    }

    func testAroundFailureCanRetryAndNeverShowsRawError() async {
        let focus = ChatMessageFocus(), anchor = row("a")
        await focus.open("a", key: key(), available: []) { throw APIError(status: 503, message: "PRIVATE PROVIDER TRACE") }
        XCTAssertNotNil(focus.error)
        XCTAssertFalse(focus.error?.contains("PRIVATE") == true)
        XCTAssertFalse(focus.error?.contains("503") == true)
        await focus.open("a", key: key(), available: []) { [anchor] }
        XCTAssertNil(focus.error)
        XCTAssertEqual(focus.messageID, "a")
    }

    func testActiveAndArchiveAroundUseReadOnlyAuthenticatedContract() async throws {
        let anchor = row("a &+")
        let data = try JSONEncoder().encode([anchor])
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: data) }
        let api = network.makeAPIClient()
        for archived in [false, true] {
            let rows = try await api.chatMessagesAround(projectID: "p", messageID: anchor.id, archived: archived)
            XCTAssertEqual(rows.first?.id, anchor.id)
        }
        XCTAssertEqual(network.requests.count, 2)
        for (request, path) in zip(network.requests, ["/api/projects/p/messages", "/api/projects/p/archive/messages"]) {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            XCTAssertEqual(request.url?.path, path)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
            let query = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
            XCTAssertEqual(query.first { $0.name == "around" }?.value, anchor.id)
            XCTAssertEqual(query.first { $0.name == "limit" }?.value, "41")
        }
        await network.close()
    }

    func testHistoryFailureStoresFriendlyTextAndKeepsRowsAndCursor() throws {
        var history = ChatHistory(key: key())
        let initial = try XCTUnwrap(history.begin(.initial))
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: .project, items: [row("a")], nextCursor: "opaque", hasOlder: true), request: initial))
        let older = try XCTUnwrap(history.begin(.older))
        history.fail(URLError(.timedOut), request: older)
        XCTAssertTrue(history.error?.contains("다시 시도") == true)
        XCTAssertFalse(history.error?.contains("NSURLErrorDomain") == true)
        XCTAssertEqual(history.nextCursor, "opaque")
        XCTAssertEqual(history.items.map(\.id), ["a"])
    }

    func testHighlightExpiresAndResetCancelsPreviousHighlight() async throws {
        let anchor = ChatScrollAnchor(scope: "p")
        anchor.highlight(messageID: "a", duration: .milliseconds(20))
        XCTAssertEqual(anchor.highlightedMessageID, "a")
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertNil(anchor.highlightedMessageID)
        anchor.highlight(messageID: "old", duration: .milliseconds(20))
        anchor.highlight(messageID: "new", duration: .seconds(30))
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(anchor.highlightedMessageID, "new")
        anchor.reset(scope: "q")
        XCTAssertNil(anchor.highlightedMessageID)
    }
}
