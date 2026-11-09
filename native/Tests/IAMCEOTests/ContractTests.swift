import XCTest
@testable import IAMCEO

final class ContractTests: XCTestCase {
    func testDecodesOlderMemberAndUnknownEnumWithoutInventingRuntime() throws {
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"worker-1","name":"A","cli":"codex","status":"starting","contextPct":37.5}"#.utf8))
        XCTAssertEqual(member.cli, "codex")
        XCTAssertEqual(member.status, "starting")
        XCTAssertEqual(member.contextPct, 37.5)
        XCTAssertNil(member.sessionId)
        XCTAssertNil(member.backend)
    }
    func testMissingOptionalCollectionsDecodeAndMalformedTypesFail() throws {
        let state = try JSONDecoder().decode(ProjectState.self, from: Data(#"{"project":{"id":"p","name":"P"}}"#.utf8))
        XCTAssertEqual(state.project.id, "p")
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertFalse(state.project.connection.ok)
        XCTAssertThrowsError(try JSONDecoder().decode(Member.self, from: Data(#"{"subagents":"two"}"#.utf8)))
    }
    func testAnswerIncludesExactVersionAndSendKeepsID() throws {
        let answer = AnswerRequest(choice: "approve", note: nil, batch: false, expectedVersion: "2026-11-06T01:02:03.000Z")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as? [String: Any])
        XCTAssertEqual(json["expectedVersion"] as? String, "2026-11-06T01:02:03.000Z")
        let request = SendMessageRequest(id: "stable-request-123", text: "Go", targetMemberId: nil, attachmentIds: [])
        let send = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(send["id"] as? String, "stable-request-123")
        XCTAssertNil(send["idempotencyKey"])
    }
    func testExplicitNullResetsMemberOverrides() throws {
        let value = PatchMemberRequest(cli: "codex", modelOverride: nil, effortOverride: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        XCTAssertTrue(json["modelOverride"] is NSNull)
        XCTAssertTrue(json["effortOverride"] is NSNull)
    }
    func testEndpointSecurityAndPathEncoding() throws {
        XCTAssertNoThrow(try ServerEndpoint("http://127.0.0.1:8787"))
        XCTAssertNoThrow(try ServerEndpoint("http://localhost:8787/"))
        // Tailscale addresses are WireGuard-encrypted and tailnet-only, so plain HTTP is allowed there.
        XCTAssertNoThrow(try ServerEndpoint("http://100.64.0.7:7878"))
        XCTAssertThrowsError(try ServerEndpoint("http://192.168.0.4:7878"))
        XCTAssertThrowsError(try ServerEndpoint("http://100.200.0.1:7878"))
        XCTAssertNoThrow(try ServerEndpoint("https://mac.tailnet.ts.net"))
        // MagicDNS names are tailnet-only and WireGuard-encrypted, like 100.x (QR pairing uses them).
        XCTAssertNoThrow(try ServerEndpoint("http://sample-mac.tail0000.ts.net:7878"))
        for invalid in ["http://ts.net", "http://example.com", "https://token@host", "https://host?token=secret", "file:///tmp", "https://host/path"] {
            XCTAssertThrowsError(try ServerEndpoint(invalid), invalid)
        }
        XCTAssertEqual(APIClient.segment("a/b?x=y&z"), "a%2Fb%3Fx%3Dy%26z")
    }
    func testForeignAttachmentCannotReceiveBearer() async throws {
        let api = APIClient(endpoint: try ServerEndpoint("https://mac.tailnet.ts.net"), accessCode: "private")
        let safe = try await api.authorizedURL("/uploads/photo.png")
        XCTAssertEqual(safe.host, "mac.tailnet.ts.net")
        do { _ = try await api.authorizedURL("https://foreign.example/file"); XCTFail("Foreign origin accepted") } catch {}
        do { _ = try await api.authorizedURL("https://mac.tailnet.ts.net:444/file"); XCTFail("Foreign port accepted") } catch {}
    }
    @MainActor func testDemoIsExplicitAndReadOnly() async {
        let store = AppStore(demo: true, persistCredentials: false)
        XCTAssertTrue(store.isDemo)
        XCTAssertEqual(store.connectionStatus, .demo)
        XCTAssertFalse(store.canWrite)
        XCTAssertNil(store.api)
        let sent = await store.sendMessage(text: "Test")
        XCTAssertFalse(sent)
        XCTAssertTrue(store.errorMessage?.contains("읽기 전용") == true)
    }
    func testClearingRankDefaultsSendsExplicitNull() throws {
        let data = try JSONEncoder().encode(Settings(ranks: ["manager": RankConfig()]))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let ranks = try XCTUnwrap(json["ranks"] as? [String: [String: Any]])
        XCTAssertTrue(ranks["manager"]?["model"] is NSNull)
        XCTAssertTrue(ranks["manager"]?["effort"] is NSNull)
    }

    func testDecisionReviewKeepsReviewedVersionAndRequiresExplicitReviewAfterRefresh() throws {
        let original = Decision(id: "decision", options: [DecisionOption(k: "a", label: "Original action")], updatedAt: "version-1")
        var review = DecisionReview(decision: original)
        review.choice = "a"
        review.note = "My draft note"
        XCTAssertTrue(review.canSubmit(comparedTo: original))

        var refreshed = original
        refreshed.updatedAt = "version-2"
        refreshed.options = [DecisionOption(k: "a", label: "A different action with the same key")]
        refreshed.lastNote = "Server-side note must not overwrite my draft"
        XCTAssertTrue(review.isStale(comparedTo: refreshed))
        XCTAssertFalse(review.canSubmit(comparedTo: refreshed))
        XCTAssertEqual(review.decision.updatedAt, "version-1")
        XCTAssertEqual(review.decision.options.first?.label, "Original action")

        review.reviewLatest(refreshed)
        XCTAssertFalse(review.isStale(comparedTo: refreshed))
        XCTAssertNil(review.choice)
        XCTAssertEqual(review.note, "My draft note")
        XCTAssertFalse(review.canSubmit(comparedTo: refreshed))
        review.choice = "a"
        XCTAssertTrue(review.canSubmit(comparedTo: refreshed))
        let request = AnswerRequest(choice: review.choice, note: review.note, batch: false, expectedVersion: review.decision.updatedAt)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(json["expectedVersion"] as? String, "version-2")
    }

    func testDecisionReviewBlocksMissingClosedOrInvalidChoice() {
        let original = Decision(id: "decision", options: [DecisionOption(k: "a", label: "Approve")], updatedAt: "version-1")
        var review = DecisionReview(decision: original)
        review.choice = "removed-option"
        XCTAssertFalse(review.canSubmit(comparedTo: original))
        review.choice = "a"
        XCTAssertFalse(review.canSubmit(comparedTo: nil))
        var closed = original
        closed.status = "answered"
        XCTAssertTrue(review.isStale(comparedTo: closed))
        XCTAssertFalse(review.canSubmit(comparedTo: closed))
        review.reviewLatest(closed)
        XCTAssertFalse(review.canSubmit(comparedTo: closed))
    }


    func testPairingLinkRoundTripAndRejectsForeignAddresses() throws {
        let link = PairingLink(code: "AB23CD45", urls: [URL(string: "http://100.64.0.7:7878")!])
        XCTAssertEqual(link.url.scheme, "iamceo")
        XCTAssertEqual(PairingLink(url: link.url), link)
        XCTAssertFalse(link.url.absoluteString.contains("accessCode"))
        // A QR that points somewhere outside the tailnet is ignored, so a forged code cannot send the phone elsewhere.
        XCTAssertNil(PairingLink(url: URL(string: "iamceo://pair?c=AB23CD45&u=http%3A%2F%2Fevil.example.com")!))
        XCTAssertNil(PairingLink(url: URL(string: "iamceo://pair?u=http%3A%2F%2F100.64.0.7%3A7878")!))
        XCTAssertNil(PairingLink(url: URL(string: "https://pair?c=AB23CD45&u=http%3A%2F%2F100.64.0.7%3A7878")!))
        XCTAssertTrue(Tailnet.isTailnetHost("100.64.0.1"))
        XCTAssertTrue(Tailnet.isTailnetHost("[fd7a:115c:a1e0::1]"))
        XCTAssertFalse(Tailnet.isTailnetHost("100.128.0.1"))
        XCTAssertFalse(Tailnet.isTailnetHost("10.0.0.1"))
        XCTAssertTrue(Tailnet.isTailnetHost("sample-mac.tail0000.ts.net"))
        XCTAssertFalse(Tailnet.isTailnetHost("ts.net"))
        XCTAssertFalse(Tailnet.isTailnetHost("evil-ts.net"))
    }

    @MainActor func testPairingQRRenders() throws {
        let link = PairingLink(code: "AB23CD45", urls: [URL(string: "http://sample-mac.tail0000.ts.net:7878")!])
        let image = try XCTUnwrap(QRCodeImage.render(link.url.absoluteString))
        XCTAssertGreaterThan(image.width, 200)
    }
}

extension ContractTests {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }
    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        let json = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(json as? [String: Any])
    }

    func testOptionalMetadataPreservesW0WindowsAndUnknownValues() throws {
        let old = try decode(Member.self, #"{"id":"m"}"#)
        XCTAssertNil(old.contextWindow)
        XCTAssertNil(old.contextState)
        XCTAssertNil(old.statusObservation)
        XCTAssertNil(old.subagentState)
        let member = try decode(Member.self, #"{"id":"m","status":"future_status","contextPct":0,"contextWindow":1000000,"contextWindowSource":"future_source","blockedReason":"status_unknown","statusObservation":{"freshness":"stale","ownership":"conflict"},"subagentState":{"quality":"unknown","count":null},"contextState":{"measurement":{"tokens":0,"fresh":false,"sessionGeneration":7},"compaction":{"id":"c","phase":"future_phase"}},"executionState":{"runId":"r","result":"error","exitCode":3}}"#)
        XCTAssertEqual(member.status, "future_status")
        XCTAssertEqual(member.contextPct, 0)
        XCTAssertEqual(member.contextWindow, 1_000_000)
        XCTAssertEqual(member.contextWindowSource, "future_source")
        XCTAssertEqual(member.blockedReason, "status_unknown")
        XCTAssertNil(member.subagentState?.count)
        XCTAssertEqual(member.statusObservation?.ownership, "conflict")
        XCTAssertEqual(member.contextState?.measurement?.fresh, false)
        XCTAssertEqual(member.contextState?.measurement?.sessionGeneration, 7)
        XCTAssertEqual(member.contextState?.compaction?.phase, .unknown)
        XCTAssertEqual(member.executionState?.exitCode, 3)
        let settings = try decode(Settings.self, #"{"contextWindowDefault":1000000,"contextWindows":{"model":190000}}"#)
        XCTAssertEqual(settings.contextWindows?["model"], 190_000)
        XCTAssertEqual(try object(settings)["contextWindowDefault"] as? Int, 1_000_000)
        XCTAssertThrowsError(try decode(Member.self, #"{"id":"m","contextWindow":"many"}"#))
    }

    func testProjectPatchOmitsNilAndKeepsFalse() throws {
        XCTAssertEqual(try object(PatchProjectRequest()).count, 0)
        let patch = try object(PatchProjectRequest(name: "New", runnerEnabled: false, archived: false))
        XCTAssertEqual(Set(patch.keys), ["name", "runnerEnabled", "archived"])
        XCTAssertEqual(patch["archived"] as? Bool, false)
        XCTAssertEqual(patch["runnerEnabled"] as? Bool, false)
        XCTAssertNil(patch["cwd"])
    }

    func testMessageScopeAndPageKeepOpaqueCursorAndFullMessages() throws {
        let member = MessageScope.member(memberId: "m/한글")
        XCTAssertEqual(try decode(MessageScope.self, String(decoding: JSONEncoder().encode(member), as: UTF8.self)), member)
        let page = try decode(MessagePage.self, #"{"projectId":"p","scope":{"kind":"member","memberId":"m"},"items":[{"id":"msg","delivery":"future","attachments":[{"id":"file","size":42}]}],"nextCursor":"opaque_-123","hasOlder":true}"#)
        XCTAssertEqual(page.scope, .member(memberId: "m"))
        XCTAssertEqual(page.items.first?.delivery, "future")
        XCTAssertEqual(page.items.first?.attachments.first?.size, 42)
        XCTAssertEqual(page.nextCursor, "opaque_-123")
        XCTAssertTrue(page.hasOlder)
        XCTAssertThrowsError(try decode(MessagePage.self, #"{"projectId":"p","scope":{"kind":"project"},"items":[]}"#))
        XCTAssertEqual(try decode(MessageScope.self, #"{"kind":"future"}"#), .unknown("future"))
        XCTAssertThrowsError(try decode(MessageScope.self, #"{"kind":"member"}"#))
    }

    func testSettingsPatchDistinguishesPreserveAndReset() throws {
        let patch = SettingsPatchRequest(ranks: ["manager": RankConfigPatch(model: .null)])
        let json = try object(patch)
        XCTAssertEqual(Set(json.keys), ["ranks"])
        let ranks = try XCTUnwrap(json["ranks"] as? [String: [String: Any]])
        XCTAssertTrue(ranks["manager"]?["model"] is NSNull)
        XCTAssertNil(ranks["manager"]?["effort"])
        XCTAssertEqual(try object(FreshSessionRequest(operationId: "op", expectedSessionGeneration: 4))["expectedSessionGeneration"] as? Int, 4)
    }

    func testV2TerminalRequestShapeAndClaimIdentity() throws {
        let claim = TerminalControlV2Request(action: .claim, operationId: "op", expectedSessionGeneration: 2, claimId: "stable")
        let json = try object(claim)
        XCTAssertEqual(json["claimId"] as? String, "stable")
        XCTAssertNil(json["inputSequence"])
        XCTAssertNil(json["leaseId"])
        let key = TerminalControlV2Request(action: .key, operationId: "op2", expectedSessionGeneration: 2, claimId: "stable", inputSequence: 1, key: .enter)
        XCTAssertEqual(try object(key)["inputSequence"] as? Int, 1)
        XCTAssertEqual(try object(key)["key"] as? String, "enter")
        XCTAssertThrowsError(try object(TerminalControlV2Request(action: .input, operationId: "op", expectedSessionGeneration: 2, claimId: "stable")))
        XCTAssertThrowsError(try object(TerminalControlV2Request(action: .release, operationId: "op", expectedSessionGeneration: 2, claimId: "stable", inputSequence: 1)))
    }

    func testOperationReceiptsDoNotTurnUnknownOrPendingIntoApplied() throws {
        let applied = try decode(OperationReceipt.self, #"{"operationId":"op","kind":"terminal_control","status":"applied","result":{"memberId":"m","action":"claim","claimId":"c","sessionGeneration":4,"leaseId":"l","expiresAt":1234567890123}}"#)
        XCTAssertEqual(applied.status, .applied)
        guard case .terminalControl(let result) = applied.result else { return XCTFail("Missing typed result") }
        XCTAssertEqual(result.expiresAt, 1_234_567_890_123)
        XCTAssertEqual(result.claimId, "c")
        let roundTrip = try JSONDecoder().decode(OperationReceipt.self, from: JSONEncoder().encode(applied))
        XCTAssertEqual(roundTrip.status, .applied)
        for status in ["pending", "refused", "unknown", "future_status"] {
            let receipt = try decode(OperationReceipt.self, "{\"operationId\":\"op\",\"kind\":\"fresh_session\",\"status\":\"\(status)\",\"code\":\"CODE\",\"result\":{\"privateBody\":\"ignored\"}}")
            XCTAssertNotEqual(receipt.status, .applied)
            XCTAssertNil(receipt.result)
            XCTAssertEqual(receipt.code, "CODE")
        }
        XCTAssertEqual(try decode(OperationReceipt.self, #"{"operationId":"op"}"#).status, .unknown)
        XCTAssertEqual(try decode(OperationReceipt.self, #"{"operationId":"op","kind":"future","status":"applied"}"#).status, .unknown)
        XCTAssertThrowsError(try decode(OperationReceipt.self, #"{"operationId":"op","kind":"fresh_session","status":"applied"}"#))
    }

    func testErrorBodyKeepsCodesAndLegacyErrors() throws {
        let error = try decode(APIErrorResponse.self, #"{"error":"Changed","code":"MESSAGE_SCOPE_CHANGED"}"#)
        XCTAssertEqual(error.code, "MESSAGE_SCOPE_CHANGED")
        XCTAssertEqual(error.error, "Changed")
        XCTAssertNil(try decode(APIErrorResponse.self, #"{"error":"Legacy"}"#).code)
        XCTAssertThrowsError(try decode(APIErrorResponse.self, #"{"code":3}"#))
        XCTAssertEqual(APIError(status: 409, message: "Legacy").status, 409)
    }

    func testDeliveryMissingSupportAndFutureReasonsFailClosed() throws {
        XCTAssertNil(try decode(ProjectState.self, #"{"project":{"id":"p"}}"#).deliveryNotices)
        let unknown = try decode(DeliveryNoticeItem.self, #"{"id":"d","phase":"needs_owner","reason":"future","allowedActions":["recheck","retry_with_risk","future"]}"#)
        XCTAssertEqual(unknown.safeAllowedActions, [.recheck])
        XCTAssertEqual(unknown.reasonDescription, "상세 내용을 확인해 주세요")
        XCTAssertTrue(try decode(DeliveryNoticeItem.self, #"{"id":"d"}"#).safeAllowedActions.isEmpty)
        XCTAssertThrowsError(try object(DeliveryRecoveryRequest(operationId: "op", expectedVersion: 1, action: .retryWithRisk)))
        XCTAssertThrowsError(try object(DeliveryRecoveryRequest(operationId: "op", expectedVersion: 0, action: .recheck)))
        XCTAssertThrowsError(try object(DeliveryRecoveryRequest(operationId: "op", expectedVersion: 1, action: .recheck, acceptDuplicateRisk: true)))
        let retry = try object(DeliveryRecoveryRequest(operationId: "op", expectedVersion: 2, action: .retryWithRisk, acceptDuplicateRisk: true))
        XCTAssertEqual(retry["acceptDuplicateRisk"] as? Bool, true)
        XCTAssertEqual(try decode(DeliveryRecoveryResult.self, #"{"operationId":"op","deliveryId":"d","outcome":"check_scheduled","committedVersion":3}"#).outcome, .checkScheduled)
    }

    func testRealtimeLegacyV2AndUnknownEvents() throws {
        let hello = try decode(RealtimeEvent.self, #"{"type":"hello","protocol":2,"epoch":"e","seq":42,"heartbeatMs":15000,"staleAfterMs":45000}"#)
        XCTAssertEqual(hello.cursor, try SyncCursor(epoch: "e", seq: 42))
        let legacy = try decode(RealtimeEvent.self, #"{"type":"hello","seq":2}"#)
        XCTAssertNil(legacy.cursor)
        XCTAssertEqual(legacy.seq, 2)
        XCTAssertNil(try decode(RealtimeEvent.self, #"{"type":"ping"}"#).cursor)
        let unknown = try decode(RealtimeEvent.self, #"{"type":"future","epoch":"e","seq":43}"#)
        XCTAssertEqual(unknown.type, "future")
        XCTAssertEqual(unknown.cursor?.seq, 43)
        let message = try decode(RealtimeEvent.self, #"{"type":"message","epoch":"e","seq":44,"message":{"id":"msg","body":"Hello"}}"#)
        XCTAssertEqual(message.message?.body, "Hello")
        for malformed in [#"{"type":"hello"}"#, #"{"type":"member","epoch":"e","seq":3}"#, #"{"type":"ping","epoch":"e"}"#, #"{"type":"ping","epoch":"","seq":1}"#, #"{"type":"ping","epoch":"e","seq":-1}"#, #"{"type":"ping","epoch":"e","seq":9007199254740992}"#] {
            XCTAssertThrowsError(try decode(RealtimeEvent.self, malformed))
        }
    }

    func testSyncStatusRevisionsAndCapabilities() throws {
        let snapshot = try decode(SyncSnapshot.self, #"{"protocol":2,"cursor":{"epoch":"e","seq":4},"requestedProjectId":"p","projectStatus":"ok","bootstrap":{"projects":[]},"state":{"project":{"id":"p"}},"revisions":{"settings":2,"members":{"m":{"configRevision":3,"sessionGeneration":4}},"todos":{"t":5}}}"#)
        XCTAssertEqual(snapshot.revisions?.members?["m"]?.sessionGeneration, 4)
        XCTAssertEqual(snapshot.revisions?.todos?["t"], 5)
        XCTAssertNil(snapshot.bootstrap.runtime)
        let archived = try decode(SyncSnapshot.self, #"{"protocol":2,"cursor":{"epoch":"e","seq":4},"requestedProjectId":"p","projectStatus":"archived","bootstrap":{"projects":[]},"state":null}"#)
        XCTAssertNil(archived.state)
        XCTAssertNil(archived.revisions)
        let missing = try decode(SyncSnapshot.self, #"{"protocol":2,"cursor":{"epoch":"e","seq":4},"bootstrap":{"projects":[]}}"#)
        XCTAssertEqual(missing.projectStatus, .unknown)
        XCTAssertThrowsError(try decode(SyncSnapshot.self, #"{"protocol":2,"cursor":{"epoch":"e","seq":4},"requestedProjectId":"p","projectStatus":"ok","bootstrap":{"projects":[]},"state":{"project":{"id":"other"}}}"#))
        let caps = try decode(ServerCapabilities.self, #"{"contractVersion":2,"capabilities":{"paging":true,"operations":false}}"#)
        XCTAssertEqual(caps.capabilities?.paging, true)
        XCTAssertEqual(caps.capabilities?.operations, false)
        XCTAssertNil(caps.capabilities?.push)
        XCTAssertNil(try decode(ServerCapabilities.self, "{}").capabilities)
    }

    func testPushDefaultsRegistrationAndPartialPreferences() throws {
        XCTAssertEqual(PushKind.supported.map(\.rawValue), ["decision", "approval_wait", "error", "report_complete", "todo_created", "report_blocked"])
        let defaults = try object(PushPreferences())
        XCTAssertEqual(defaults.count, 6)
        XCTAssertTrue(defaults.values.allSatisfy { ($0 as? Bool) == true })
        XCTAssertEqual(PushContract.reportGroupWindowMilliseconds, 120_000)
        let decoded = try decode(PushPreferences.self, #"{"decision":true}"#)
        XCTAssertFalse(decoded.reportComplete)
        XCTAssertFalse(decoded.approvalWait)
        XCTAssertFalse(decoded.todoCreated); XCTAssertFalse(decoded.reportBlocked)
        let existing = try decode(PushPreferences.self, #"{"decision":true,"approval_wait":false,"error":true,"report_complete":false,"todo_created":true,"report_blocked":false}"#)
        XCTAssertTrue(existing.todoCreated); XCTAssertFalse(existing.reportBlocked)
        XCTAssertEqual(try decode(PushPreferences.self, String(data: JSONEncoder().encode(existing), encoding: .utf8)!), existing)
        XCTAssertEqual(try object(PushPreferencesPatch(todoCreated: false))["todo_created"] as? Bool, false)
        XCTAssertEqual(Set(try object(PushPreferencesPatch(todoCreated: false)).keys), ["todo_created"])
        XCTAssertEqual(Set(try object(PushPreferencesPatch(reportBlocked: true)).keys), ["report_blocked"])
        let registration = PushRegistrationRequest(expectedRevision: nil, environment: .sandbox, deviceToken: "ab", authorization: .authorized)
        let json = try object(registration)
        XCTAssertTrue(json["expectedRevision"] is NSNull)
        XCTAssertEqual(json["bundleId"] as? String, "com.yehsung.iamceo")
        XCTAssertNil(json["enabled"])
        let patch = try object(PushPreferencesPatch(reportComplete: false))
        XCTAssertEqual(Set(patch.keys), ["report_complete"])
        XCTAssertEqual(patch["report_complete"] as? Bool, false)
        XCTAssertFalse(PushAuthorization.unknown.permitsNotifications)
    }

    func testPushUnknownsTargetsAndTokenRedaction() throws {
        let device = try decode(PushDevice.self, #"{"id":"i","state":"future","authorization":"future","deviceToken":"do-not-retain"}"#)
        XCTAssertEqual(device.state, .unknown)
        XCTAssertEqual(device.authorization, .unknown)
        XCTAssertNil(device.enabled)
        XCTAssertNil(try object(device)["deviceToken"])
        let target = PushTarget.chat(projectId: "p", memberId: nil, messageId: "last", groupId: "g")
        let targetJSON = try object(target)
        XCTAssertTrue(targetJSON["memberId"] is NSNull)
        XCTAssertEqual(try JSONDecoder().decode(PushTarget.self, from: JSONEncoder().encode(target)), target)
        XCTAssertEqual(try decode(PushTarget.self, #"{"screen":"future"}"#), .unknown("future"))
        XCTAssertThrowsError(try decode(PushTarget.self, #"{"screen":"inbox","projectId":"p"}"#))
        let event = try decode(PushEventTarget.self, #"{"serverId":"s","eventId":"e","target":{"screen":"home"},"reportGroup":{"id":"g","projectId":"p","memberId":"m","openedAt":"t","closesAt":"t120","lastMessageId":"last","reportIds":["first","last"]}}"#)
        XCTAssertEqual(event.reportGroup?.reportIds, ["first", "last"])
    }
}

extension ContractTests {
    func testEveryAppliedReceiptUsesTheServerResultShape() throws {
        let samples = [
            ("fresh_session", #"{"member":{"id":"m"},"sessionGeneration":3}"#),
            ("settings", #"{"settings":{"notifyMac":true},"revision":4}"#),
            ("member_config", #"{"member":{"id":"m"},"configRevision":5,"sessionGeneration":3}"#),
            ("todo_done", #"{"todo":{"id":"t","done":true},"revision":6}"#)
        ]
        for (kind, result) in samples {
            let receipt = try decode(OperationReceipt.self, "{\"operationId\":\"op\",\"kind\":\"\(kind)\",\"status\":\"applied\",\"result\":\(result)}")
            XCTAssertEqual(receipt.status, .applied)
            XCTAssertNotNil(receipt.result)
            let encoded = try object(receipt)
            XCTAssertEqual(encoded["kind"] as? String, kind)
            XCTAssertNil(encoded["outcome"])
            XCTAssertEqual(try JSONDecoder().decode(OperationReceipt.self, from: JSONEncoder().encode(receipt)).status, .applied)
        }
    }
}
