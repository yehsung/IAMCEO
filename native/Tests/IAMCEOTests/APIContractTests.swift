import Foundation
import XCTest
@testable import IAMCEO

final class APIContractTests: XCTestCase {
    private func json(_ text: String, status: Int = 200) -> IsolatedTestHTTPReply {
        IsolatedTestHTTPReply(status: status, data: Data(text.utf8))
    }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let value = request.httpBody { data = value }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var value = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
                if count == 0 { break }
                value.append(buffer, count: count)
            }
            data = value
        } else { throw URLError(.zeroByteResource) }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func query(_ request: URLRequest) throws -> [String: String] {
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        let items = components.queryItems ?? []
        XCTAssertEqual(Set(items.map(\.name)).count, items.count)
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }
    private func check(_ request: URLRequest, path: String, method: String = "GET", timeout: TimeInterval = 30, revision: Int? = nil, v2: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }, path, file: file, line: line)
        XCTAssertEqual(request.httpMethod, method, file: file, line: line)
        XCTAssertEqual(request.timeoutInterval, timeout, file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only", file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), revision.map { "\"\($0)\"" }, file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-IAMCEO-Contract"), v2 ? "2" : nil, file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json", file: file, line: line)
        XCTAssertFalse(request.httpShouldHandleCookies, file: file, line: line)
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData, file: file, line: line)
    }

    func testHistoryAndArchiveRoutesKeepOpaqueQueriesAndResponseShapes() async throws {
        let fixture = try IsolatedTestNetwork { request in
            let text: String
            switch request.url?.path {
            case let path? where path.hasSuffix("/messages/page"):
                text = #"{"projectId":"p/a?b&c","scope":{"kind":"project"},"items":[{"id":"m"}],"nextCursor":"opaque-next","hasOlder":true}"#
            case let path? where path.hasSuffix("/archive/state"):
                text = #"{"project":{"id":"p/a?b&c","archived":true},"messages":[{"id":"old"}]}"#
            case "/api/projects/archived": text = #"[{"id":"archived","archived":true}]"#
            case let path? where path.hasSuffix("/messages"): text = #"[{"id":"anchor"},{"id":"after"}]"#
            case let path? where path.hasPrefix("/api/messages/"): text = #"{"id":"anchor","body":"accepted"}"#
            default: throw URLError(.resourceUnavailable)
            }
            return IsolatedTestHTTPReply(data: Data(text.utf8))
        }
        let api = fixture.makeAPIClient()
        let history: any MessageHistoryService = api
        let projects: any ProjectManagementService = api
        let page = try await history.messagePage(projectID: "p/a?b&c", scope: .member(memberId: "worker /?&한"), cursor: "opaque+/_=&?#%", limit: 100)
        XCTAssertEqual(page.items.map(\.id), ["m"])
        XCTAssertEqual(page.scope, .project) // The server may normalize a lead member to project scope.
        XCTAssertTrue(page.hasOlder)
        XCTAssertEqual(page.nextCursor, "opaque-next")
        check(fixture.requests[0], path: "/api/projects/p%2Fa%3Fb%26c/messages/page")
        XCTAssertEqual(try query(fixture.requests[0]), ["scope": "member", "memberId": "worker /?&한", "cursor": "opaque+/_=&?#%", "limit": "100"])
        _ = try await history.archivedMessagePage(projectID: "p/a?b&c", scope: .project, cursor: nil, limit: 200)
        check(fixture.requests[1], path: "/api/projects/p%2Fa%3Fb%26c/archive/messages/page")
        XCTAssertEqual(try query(fixture.requests[1]), ["scope": "project", "limit": "200"])
        let around = try await history.messagesAround(projectID: "p/a?b&c", messageID: "anchor /?&", limit: 41)
        XCTAssertEqual(around.map(\.id), ["anchor", "after"])
        check(fixture.requests[2], path: "/api/projects/p%2Fa%3Fb%26c/messages")
        XCTAssertEqual(try query(fixture.requests[2]), ["around": "anchor /?&", "limit": "41"])
        let message = try await history.message(id: "anchor/?")
        XCTAssertEqual(message.body, "accepted")
        check(fixture.requests[3], path: "/api/messages/anchor%2F%3F")
        let archived = try await projects.archivedProjects()
        XCTAssertEqual(archived.map(\.id), ["archived"])
        check(fixture.requests[4], path: "/api/projects/archived")
        let state = try await projects.archiveState(projectID: "p/a?b&c")
        XCTAssertTrue(state.project.archived)
        XCTAssertEqual(state.messages.map(\.id), ["old"])
        check(fixture.requests[5], path: "/api/projects/p%2Fa%3Fb%26c/archive/state")
        await fixture.close()
    }

    func testProjectPatchPreservesFalseAndOmitsUneditedValues() async throws {
        let fixture = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(data: Data(#"{"id":"p","name":"Renamed","archived":false}"#.utf8))
        }
        let project = try await fixture.makeAPIClient().patchProject(id: "p/?", request: PatchProjectRequest(name: "Renamed", archived: false))
        XCTAssertEqual(project.name, "Renamed")
        let request = try XCTUnwrap(fixture.requests.last)
        check(request, path: "/api/projects/p%2F%3F", method: "PATCH", timeout: 150)
        let payload = try body(request)
        XCTAssertEqual(payload["name"] as? String, "Renamed")
        XCTAssertEqual(payload["archived"] as? Bool, false)
        XCTAssertEqual(Set(payload.keys), ["name", "archived"])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        await fixture.close()
    }

    func testCapabilitiesAndSyncDoNotInventStateOrRevisions() async throws {
        let fixture = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/capabilities" {
                return IsolatedTestHTTPReply(data: Data(#"{"contractVersion":2,"capabilities":{"paging":true,"realtime":true,"push":false,"operations":false}}"#.utf8))
            }
            return IsolatedTestHTTPReply(data: Data(#"{"protocol":2,"cursor":{"epoch":"epoch-1","seq":12},"requestedProjectId":"p /?&","projectStatus":"archived","bootstrap":{"projects":[],"settings":{}},"state":null,"revisions":{"settings":7,"members":{"m":{"configRevision":8,"sessionGeneration":9}},"todos":{"t":10}}}"#.utf8))
        }
        let service: any SyncService = fixture.makeAPIClient()
        let capabilities = try await service.capabilities()
        XCTAssertEqual(capabilities.capabilities?.paging, true)
        XCTAssertEqual(capabilities.capabilities?.push, false)
        XCTAssertNil(capabilities.capabilities?.delivery)
        let snapshot = try await service.sync(projectID: "p /?&")
        XCTAssertEqual(snapshot.cursor.seq, 12)
        XCTAssertEqual(snapshot.projectStatus, .archived)
        XCTAssertNil(snapshot.state)
        XCTAssertEqual(snapshot.revisions?.members?["m"]?.sessionGeneration, 9)
        check(fixture.requests[0], path: "/api/capabilities")
        check(fixture.requests[1], path: "/api/sync")
        XCTAssertEqual(try query(fixture.requests[1]), ["projectId": "p /?&"])
        await fixture.close()
        let noProject = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(data: Data(#"{"protocol":2,"cursor":{"epoch":"e","seq":0},"projectStatus":"none","bootstrap":{"projects":[],"settings":{}},"state":null}"#.utf8))
        }
        let empty = try await noProject.makeAPIClient().sync(projectID: nil)
        XCTAssertNil(empty.requestedProjectId)
        XCTAssertNil(noProject.requests.first?.url?.query)
        await noProject.close()
    }

    func testOnlyCapabilities404FallsBackAndOtherFailuresPropagate() async throws {
        for status in [400, 401, 403, 404, 409, 500, 501, 503] {
            let fixture = try IsolatedTestNetwork { _ in
                IsolatedTestHTTPReply(status: status, data: Data(#"{"error":"failure","code":"SERVER_CODE"}"#.utf8))
            }
            do {
                let capabilities = try await fixture.makeAPIClient().capabilities()
                XCTAssertEqual(status, 404)
                XCTAssertNil(capabilities.contractVersion)
                XCTAssertNil(capabilities.capabilities)
            } catch let error as APIError {
                XCTAssertNotEqual(status, 404)
                XCTAssertEqual(error.status, status)
                XCTAssertEqual(error.code, "SERVER_CODE")
            }
            XCTAssertEqual(fixture.requests.count, 1)
            await fixture.close()
        }
        for reply in [json("invalid"), json(#"{"capabilities":{"paging":"yes"}}"#)] {
            let fixture = try IsolatedTestNetwork { _ in reply }
            do { _ = try await fixture.makeAPIClient().capabilities(); XCTFail("Malformed capabilities succeeded") }
            catch let error as APIError { XCTAssertEqual(error.status, 0) }
            await fixture.close()
        }
        let offline = try IsolatedTestNetwork { _ in throw URLError(.timedOut) }
        do { _ = try await offline.makeAPIClient().capabilities(); XCTFail("Timeout became legacy capabilities") }
        catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        XCTAssertEqual(offline.requests.count, 1)
        await offline.close()
    }

    func testMissingPageSyncAndMessageStayErrorsWithoutImplicitFallback() async throws {
        let fixture = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(status: 404, data: Data(#"{"error":"보관된 프로젝트입니다"}"#.utf8))
        }
        let api = fixture.makeAPIClient()
        do { _ = try await api.messagePage(projectID: "p", scope: .project, cursor: nil, limit: 200); XCTFail("404 became a page") }
        catch let error as APIError { XCTAssertEqual(error.status, 404); XCTAssertNil(error.code) }
        do { _ = try await api.sync(projectID: "p"); XCTFail("404 became a snapshot") }
        catch let error as APIError { XCTAssertEqual(error.status, 404) }
        do { _ = try await api.message(id: "m"); XCTFail("404 became a message") }
        catch let error as APIError { XCTAssertEqual(error.status, 404) }
        XCTAssertEqual(fixture.requests.count, 3)
        XCTAssertFalse(fixture.requests.contains { $0.url?.path.hasSuffix("/state") == true })
        await fixture.close()
    }

    func testV2WritesSendCASAndOnlyEditedSettingsFields() async throws {
        let fixture = try IsolatedTestNetwork { request in
            let text: String
            switch request.url?.path {
            case "/api/settings": text = #"{"settings":{},"revision":8}"#
            case let path? where path.hasSuffix("/done"): text = #"{"todo":{"id":"t","done":false},"revision":10}"#
            default: text = #"{"member":{"id":"m"},"configRevision":9,"sessionGeneration":4}"#
            }
            return IsolatedTestHTTPReply(data: Data(text.utf8))
        }
        let service: any OperationService = fixture.makeAPIClient()
        let settings = try await service.patchSettings(request: SettingsPatchRequest(ranks: ["manager": RankConfigPatch(model: .null)]), revision: 7)
        XCTAssertEqual(settings.revision, 8)
        let member = try await service.patchMember(id: "m/?", request: PatchMemberRequest(cli: "codex", modelOverride: nil, effortOverride: nil), revision: 8)
        XCTAssertEqual(member.configRevision, 9)
        let todo = try await service.patchTodo(id: "t/?", request: TodoPatchRequest(done: false), revision: 9)
        XCTAssertEqual(todo.revision, 10)
        check(fixture.requests[0], path: "/api/settings", method: "PUT", timeout: 20, revision: 7, v2: true)
        check(fixture.requests[1], path: "/api/members/m%2F%3F", method: "PATCH", timeout: 150, revision: 8, v2: true)
        check(fixture.requests[2], path: "/api/todos/t%2F%3F/done", method: "POST", timeout: 20, revision: 9, v2: true)
        let settingsBody = try body(fixture.requests[0])
        XCTAssertEqual(Set(settingsBody.keys), ["ranks"])
        let ranks = try XCTUnwrap(settingsBody["ranks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(ranks["manager"]!.keys), ["model"])
        XCTAssertTrue(ranks["manager"]?["model"] is NSNull)
        let memberBody = try body(fixture.requests[1])
        XCTAssertTrue(memberBody["modelOverride"] is NSNull)
        XCTAssertTrue(memberBody["effortOverride"] is NSNull)
        XCTAssertEqual(try body(fixture.requests[2])["done"] as? Bool, false)
        await fixture.close()
    }

    func testOperationReceiptLookupAndFreshTerminalIdentity() async throws {
        let fixture = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true {
                return IsolatedTestHTTPReply(data: Data(#"{"operationId":"input-op","kind":"terminal_control","status":"applied","result":{"memberId":"m","action":"key","claimId":"claim","sessionGeneration":4,"inputSequence":2}}"#.utf8))
            }
            return IsolatedTestHTTPReply(status: 202, data: Data(#"{"operationId":"fresh-op","kind":"fresh_session","status":"pending"}"#.utf8))
        }
        let api = fixture.makeAPIClient()
        let pending = try await api.freshSession(memberID: "m/?", request: FreshSessionRequest(operationId: "fresh-op", expectedSessionGeneration: 3))
        XCTAssertEqual(pending.status, .pending)
        XCTAssertNil(pending.result)
        let applied = try await api.terminalControl(memberID: "m/?", request: TerminalControlV2Request(action: .key, operationId: "input-op", expectedSessionGeneration: 4, claimId: "claim", inputSequence: 2, key: .enter))
        XCTAssertEqual(applied.status, .applied)
        guard case .terminalControl(let result) = applied.result else { return XCTFail("Missing terminal result") }
        XCTAssertEqual(result.inputSequence, 2)
        let lookup = try await api.operation(id: "fresh-op/?")
        XCTAssertEqual(lookup.operationId, "fresh-op")
        check(fixture.requests[0], path: "/api/members/m%2F%3F/fresh-session", method: "POST", timeout: 150, v2: true)
        check(fixture.requests[1], path: "/api/members/m%2F%3F/terminal/control", method: "POST", timeout: 20, v2: true)
        check(fixture.requests[2], path: "/api/operations/fresh-op%2F%3F", v2: true)
        let freshBody = try body(fixture.requests[0])
        XCTAssertEqual(freshBody["operationId"] as? String, "fresh-op")
        XCTAssertEqual(freshBody["expectedSessionGeneration"] as? Int, 3)
        let inputBody = try body(fixture.requests[1])
        XCTAssertEqual(inputBody["claimId"] as? String, "claim")
        XCTAssertEqual(inputBody["inputSequence"] as? Int, 2)
        XCTAssertEqual(inputBody["key"] as? String, "enter")
        XCTAssertNil(inputBody["leaseId"])
        await fixture.close()
    }

    func testUnknownAndRefusedOperationsAndHTTPConflictKeepCodes() async throws {
        for status in ["unknown", "refused"] {
            let fixture = try IsolatedTestNetwork { _ in
                IsolatedTestHTTPReply(data: Data("{\"operationId\":\"op\",\"kind\":\"terminal_control\",\"status\":\"\(status)\",\"code\":\"INPUT_UNCERTAIN\",\"error\":\"not settled\"}".utf8))
            }
            let receipt = try await fixture.makeAPIClient().operation(id: "op")
            XCTAssertEqual(receipt.status.rawValue, status)
            XCTAssertEqual(receipt.code, "INPUT_UNCERTAIN")
            XCTAssertNil(receipt.result)
            await fixture.close()
        }
        let fixture = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(status: 409, data: Data(#"{"message":"Changed","code":"REVISION_CONFLICT"}"#.utf8))
        }
        do { _ = try await fixture.makeAPIClient().patchTodo(id: "t", request: TodoPatchRequest(done: true), revision: 1); XCTFail("Conflict succeeded") }
        catch let error as APIError {
            XCTAssertEqual(error.status, 409)
            XCTAssertEqual(error.message, "Changed")
            XCTAssertEqual(error.code, "REVISION_CONFLICT")
        }
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.close()
    }

    func testDeliveryPageAndRecoveryKeepCursorVersionAndScheduledOutcome() async throws {
        let fixture = try IsolatedTestNetwork { request in
            if request.httpMethod == "GET" {
                return IsolatedTestHTTPReply(data: Data(#"{"memberId":"m","summary":{"memberId":"m","undeliveredCount":1,"unknownCount":0,"deliveringCount":0,"checkingCount":1,"needsOwnerCount":0,"waitingBehindCount":0,"oldestAt":null,"reasons":[]},"items":[{"id":"d","phase":"checking"}],"nextBefore":"opaque"}"#.utf8))
            }
            return IsolatedTestHTTPReply(status: 202, data: Data(#"{"operationId":"op","deliveryId":"d","outcome":"check_scheduled","committedVersion":4}"#.utf8))
        }
        let service: any DeliveryNoticeService = fixture.makeAPIClient()
        let page = try await service.deliveryNotices(memberID: "m/?", before: "cursor+/?&", limit: 50)
        XCTAssertEqual(page.nextBefore, "opaque")
        let result = try await service.recoverDelivery(id: "d/?", request: DeliveryRecoveryRequest(operationId: "op", expectedVersion: 3, action: .recheck))
        XCTAssertEqual(result.outcome, .checkScheduled)
        check(fixture.requests[0], path: "/api/members/m%2F%3F/delivery-notices")
        XCTAssertEqual(try query(fixture.requests[0]), ["before": "cursor+/?&", "limit": "50"])
        check(fixture.requests[1], path: "/api/deliveries/d%2F%3F/recovery", method: "POST", timeout: 20, v2: true)
        XCTAssertEqual(try body(fixture.requests[1])["expectedVersion"] as? Int, 3)
        await fixture.close()
    }

    func testPushCRUDTestAndTargetUseDedicatedContracts() async throws {
        let fixture = try IsolatedTestNetwork { request in
            let text: String
            var status = 200
            switch request.url?.path {
            case "/api/push/status": text = #"{"serverId":"server","supported":true,"providers":[]}"#
            case "/api/push/devices": text = #"{"devices":[{"id":"device","enabled":false,"revision":1}]}"#
            case let path? where path.hasSuffix("/test"):
                status = 202; text = #"{"notificationId":"notification","state":"queued"}"#
            case let path? where path.hasSuffix("/target"):
                text = #"{"serverId":"server","eventId":"event","target":{"screen":"chat","projectId":"p","memberId":"m","messageId":"old","groupId":"group"},"reportGroup":{"id":"group","projectId":"p","memberId":"m","openedAt":"a","closesAt":"b","lastMessageId":"old","reportIds":["first","old"]}}"#
            default:
                if request.httpMethod == "DELETE" { text = #"{"ok":true}"# }
                else {
                    status = request.httpMethod == "PUT" ? 201 : 200
                    text = #"{"id":"device","enabled":false,"revision":2}"#
                }
            }
            return IsolatedTestHTTPReply(status: status, data: Data(text.utf8))
        }
        let service: any PushService = fixture.makeAPIClient()
        let status = try await service.pushStatus()
        XCTAssertEqual(status.serverId, "server")
        let devices = try await service.pushDevices()
        XCTAssertEqual(devices.devices.count, 1)
        _ = try await service.pushDevice(id: "device/?")
        _ = try await service.registerPushDevice(id: "device/?", request: PushRegistrationRequest(expectedRevision: nil, environment: .sandbox, deviceToken: "fixture-token", authorization: .authorized))
        _ = try await service.patchPushDevice(id: "device/?", request: PushDevicePatchRequest(expectedRevision: 2, enabled: false, preferences: PushPreferencesPatch(reportComplete: false)))
        try await service.revokePushDevice(id: "device/?", revision: 3)
        let test = try await service.testPushDevice(id: "device/?", request: PushTestRequest(requestId: "stable-test-id"))
        XCTAssertEqual(test.state, .queued)
        let target = try await service.pushTarget(eventID: "event/?")
        XCTAssertEqual(target.reportGroup?.reportIds, ["first", "old"])
        check(fixture.requests[0], path: "/api/push/status")
        check(fixture.requests[1], path: "/api/push/devices")
        check(fixture.requests[2], path: "/api/push/devices/device%2F%3F")
        check(fixture.requests[3], path: "/api/push/devices/device%2F%3F", method: "PUT", timeout: 20)
        check(fixture.requests[4], path: "/api/push/devices/device%2F%3F", method: "PATCH", timeout: 20)
        check(fixture.requests[5], path: "/api/push/devices/device%2F%3F", method: "DELETE", timeout: 20, revision: 3)
        check(fixture.requests[6], path: "/api/push/devices/device%2F%3F/test", method: "POST", timeout: 20)
        check(fixture.requests[7], path: "/api/push/events/event%2F%3F/target")
        let registration = try body(fixture.requests[3])
        XCTAssertTrue(registration["expectedRevision"] is NSNull)
        XCTAssertEqual(registration["bundleId"] as? String, "com.yehsung.iamceo")
        XCTAssertEqual(registration["deviceToken"] as? String, "fixture-token")
        XCTAssertNil(registration["enabled"])
        let patch = try body(fixture.requests[4])
        XCTAssertEqual(patch["expectedRevision"] as? Int, 2)
        XCTAssertEqual(patch["enabled"] as? Bool, false)
        XCTAssertEqual(patch["preferences"] as? [String: Bool], ["report_complete": false])
        XCTAssertNil(fixture.requests[5].httpBody)
        XCTAssertEqual(try body(fixture.requests[6])["requestId"] as? String, "stable-test-id")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.url?.query == nil })
        await fixture.close()
    }

    func testWebSocketRequestNeverPlacesCodeInURLAndSupportsHeaderOnlyV1() async throws {
        let fixture = try IsolatedTestNetwork()
        let api = fixture.makeAPIClient(accessCode: "code+/?&secret")
        let v2 = try await api.webSocketRequest()
        XCTAssertEqual(v2.url?.scheme, "ws")
        XCTAssertEqual(v2.url?.host, fixture.endpoint.url.host)
        XCTAssertEqual(v2.url?.port, fixture.endpoint.url.port)
        XCTAssertEqual(v2.url?.path, "/ws")
        XCTAssertEqual(try query(v2), ["v": "2"])
        XCTAssertEqual(v2.value(forHTTPHeaderField: "Authorization"), "Bearer code+/?&secret")
        XCTAssertFalse(v2.url!.absoluteString.contains("secret"))
        XCTAssertNil(v2.httpBody)
        XCTAssertFalse(v2.httpShouldHandleCookies)
        let v1 = try await api.webSocketRequest(version: 1)
        XCTAssertNil(v1.url?.query)
        let transport = try await fixture.webSockets.connect(request: v1)
        await transport.close()
        let secure = APIClient(endpoint: try ServerEndpoint("https://example.invalid:9443"), accessCode: "secret", session: fixture.session)
        let wss = try await secure.webSocketRequest()
        XCTAssertEqual(wss.url?.scheme, "wss")
        XCTAssertEqual(wss.url?.port, 9443)
        do { _ = try await api.webSocketRequest(version: 3); XCTFail("Unsupported protocol succeeded") } catch {}
        XCTAssertTrue(fixture.requests.isEmpty) // Building requests never opens a socket or sends HTTP.
        await fixture.close()
    }
}
