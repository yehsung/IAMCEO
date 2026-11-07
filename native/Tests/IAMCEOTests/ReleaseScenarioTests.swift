import Foundation
import XCTest
import Darwin
@testable import IAMCEO

/// Owns one Bun fixture process. It supplies the only allowed HTTP address;
/// no live daemon, Keychain, UserDefaults, provider or APNs service is used.
private final class ReleaseHost {
    struct Info: Decodable {
        let url: String
        let token: String
        let projectId: String
        let memberId: String
        let calls: [String: Int]
    }
    let process = Process()
    private let input = Pipe(), output = Pipe()
    private let root: URL
    private(set) var info: Info!
    private var closed = false

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-swift-release-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { repo.deleteLastPathComponent() }
        let candidates = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)).appendingPathComponent("bun") }
        guard let bun = candidates.first(where: { $0.path.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            try? FileManager.default.removeItem(at: root)
            throw APIError(status: 0, message: "Bun is required for the release integration fixture")
        }
        process.executableURL = bun
        process.arguments = [repo.appendingPathComponent("tests/core-release.test.ts").path, "--swift-fixture"]
        process.currentDirectoryURL = repo
        // A child-only allowlist; parent HOME and provider environment stay intact.
        process.environment = ["PATH": bun.deletingLastPathComponent().path, "HOME": root.path, "TMPDIR": root.path,
                               "IAMCEO_TEST": "1", "IAMCEO_PORT": "0", "IAMCEO_HOME": root.appendingPathComponent("unused").path,
                               "IAMCEO_CORE_BIN": "/usr/bin/false", "IAMCEO_CLAUDE_BIN": "/usr/bin/false", "IAMCEO_CODEX_BIN": "/usr/bin/false",
                               "IAMCEO_CORE_SOCKET": root.appendingPathComponent("no-core.sock").path,
                               "IAMCEO_HERDR_SOCKET": root.appendingPathComponent("no-herdr.sock").path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run(); info = try readInfo() }
        catch { close(); throw error }
    }
    private func readInfo() throws -> Info {
        let deadline = Date().addingTimeInterval(10)
        var line = Data()
        while Date() < deadline {
            var descriptor = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
            guard poll(&descriptor, 1, 100) >= 0 else { throw URLError(.cannotOpenFile) }
            if descriptor.revents & Int16(POLLIN | POLLHUP) == 0 { continue }
            guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else {
                throw APIError(status: 0, message: "Bun release fixture exited before handshake")
            }
            if byte.first == 10 {
                if let text = String(data: line, encoding: .utf8), text.hasPrefix("W10:") {
                    let result = try JSONDecoder().decode(Info.self, from: Data(text.dropFirst(4).utf8))
                    let url = try ServerEndpoint(result.url).url
                    guard url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, port != 7878 else { throw URLError(.unsupportedURL) }
                    return result
                }
                line.removeAll(keepingCapacity: true)
            } else { line.append(byte) }
        }
        throw URLError(.timedOut)
    }
    @discardableResult func command(_ action: String) throws -> Info {
        try input.fileHandleForWriting.write(contentsOf: Data("{\"action\":\"\(action)\"}\n".utf8))
        info = try readInfo()
        return info
    }
    func api() throws -> APIClient { APIClient(endpoint: try ServerEndpoint(info.url), accessCode: info.token) }
    func close() {
        guard !closed else { return }; closed = true
        if process.isRunning {
            try? input.fileHandleForWriting.write(contentsOf: Data("{\"action\":\"stop\"}\n".utf8))
            try? input.fileHandleForWriting.close()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { process.terminate() }
            let terminateDeadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < terminateDeadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        try? output.fileHandleForReading.close()
        try? FileManager.default.removeItem(at: root)
    }
    deinit { close() }
}

@MainActor final class ReleaseScenarioTests: XCTestCase {
    func testSwiftHTTPUnknownEnterAndLeaseSurviveDaemonRestartWithoutReplay() async throws {
        let host = try ReleaseHost(); defer { host.close() }
        var api = try host.api()
        let snapshot = try await api.sync(projectID: host.info.projectId)
        let generation = try XCTUnwrap(snapshot.revisions?.members?[host.info.memberId]?.sessionGeneration)
        let claimID = UUID().uuidString
        let claim = TerminalControlV2Request(action: .claim, operationId: UUID().uuidString, expectedSessionGeneration: generation, claimId: claimID)
        let claimed = try await api.terminalControl(memberID: host.info.memberId, request: claim)
        XCTAssertEqual(claimed.status, .applied)
        try host.command("drop-key")
        let input = TerminalControlV2Request(action: .key, operationId: UUID().uuidString, expectedSessionGeneration: generation, claimId: claimID, inputSequence: 1, key: .enter)
        let unknown = try await api.terminalControl(memberID: host.info.memberId, request: input)
        XCTAssertEqual(unknown.status, .unknown)
        try host.command("restart"); api = try host.api()
        let restored = try await api.operation(id: input.operationId)
        let replay = try await api.terminalControl(memberID: host.info.memberId, request: input)
        XCTAssertEqual(restored.status, .unknown); XCTAssertEqual(replay.status, .unknown)
        XCTAssertEqual(restored.operationId, input.operationId)
        let sameClaim = try await api.terminalControl(memberID: host.info.memberId, request: claim)
        XCTAssertEqual(sameClaim.status, .applied)
        let counts = try host.command("stats").calls
        XCTAssertEqual(counts["terminal.keys"], 1); XCTAssertEqual(counts["terminal.send"], 0)
        XCTAssertEqual(counts["terminal.run"], 1); XCTAssertEqual(counts["terminal.kill"], 0)
    }

    func testTwoSwiftClientsCASAndFreshReceiptUseRealServerRevisions() async throws {
        let host = try ReleaseHost(); defer { host.close() }
        let first = try host.api(), second = try host.api()
        let snapshot = try await first.sync(projectID: host.info.projectId)
        let revision = try XCTUnwrap(snapshot.revisions?.settings)
        let updated = try await first.patchSettings(request: SettingsPatchRequest(compactAtPct: 75), revision: revision)
        XCTAssertGreaterThan(updated.revision, revision)
        do {
            _ = try await second.patchSettings(request: SettingsPatchRequest(permissionMode: "auto"), revision: revision)
            XCTFail("Stale client overwrote settings")
        } catch let error as APIError { XCTAssertEqual(error.status, 409) }
        let current = try await second.sync(projectID: host.info.projectId)
        XCTAssertEqual(current.bootstrap.settings.compactAtPct, 75)
        XCTAssertEqual(current.bootstrap.settings.permissionMode, snapshot.bootstrap.settings.permissionMode)
        let generation = try XCTUnwrap(current.revisions?.members?[host.info.memberId]?.sessionGeneration)
        let request = FreshSessionRequest(operationId: UUID().uuidString, expectedSessionGeneration: generation)
        let receipt = try await first.freshSession(memberID: host.info.memberId, request: request)
        XCTAssertEqual(receipt.status, .applied)
        let replay = try await second.freshSession(memberID: host.info.memberId, request: request)
        XCTAssertEqual(replay.status, .applied); XCTAssertEqual(replay.operationId, receipt.operationId)
        let counts = try host.command("stats").calls
        XCTAssertEqual(counts["terminal.run"], 2); XCTAssertEqual(counts["terminal.kill"], 1)
    }

    func testSwiftArchiveSnapshotAndCursorContractsAcrossRealHTTP() async throws {
        let host = try ReleaseHost(); defer { host.close() }
        let api = try host.api()
        let capabilities = try await api.capabilities()
        XCTAssertEqual(capabilities.contractVersion, 2)
        let initial = try await api.sync(projectID: host.info.projectId)
        let session = try XCTUnwrap(initial.state?.members.first { $0.id == host.info.memberId }?.sessionId)
        let renamed = try await api.patchProject(id: host.info.projectId, request: PatchProjectRequest(name: "Swift rename"))
        XCTAssertEqual(renamed.id, host.info.projectId)
        let page = try await api.messagePage(projectID: host.info.projectId, scope: .project, cursor: nil, limit: 200)
        XCTAssertEqual(page.projectId, host.info.projectId)
        let archived = try await api.patchProject(id: host.info.projectId, request: PatchProjectRequest(archived: true))
        XCTAssertTrue(archived.archived)
        let state = try await api.archiveState(projectID: host.info.projectId)
        XCTAssertEqual(state.members.first { $0.id == host.info.memberId }?.sessionId, session)
        let history = try await api.archivedMessagePage(projectID: host.info.projectId, scope: .project, cursor: nil, limit: 100)
        XCTAssertEqual(history.projectId, host.info.projectId)
        do { _ = try await api.messagePage(projectID: host.info.projectId, scope: .project, cursor: nil, limit: 100); XCTFail("Active route read archived project") }
        catch let error as APIError { XCTAssertEqual(error.status, 404) }
        let before = try host.command("stats").calls
        try host.command("restart")
        let restarted = try host.api()
        let restoredArchive = try await restarted.archiveState(projectID: host.info.projectId)
        XCTAssertEqual(restoredArchive.project.name, "Swift rename")
        let after = try host.command("stats").calls
        XCTAssertEqual(after["terminal.run"], before["terminal.run"]); XCTAssertEqual(after["terminal.send"], 0)
    }

    func testAppRestartKeepsAcceptedMessageAndLaterDraftRevisionWithAttachments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-release-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        server.change { $0.dropMessage = true }
        let network = try IsolatedTestNetwork { try server.handle($0) }
        let draftURL = root.appendingPathComponent("draft.json"), attemptURL = root.appendingPathComponent("attempt.json"), journalURL = root.appendingPathComponent("write.json")
        func store() throws -> AppStore {
            let value = AppStore(session: network.session, persistCredentials: false, drafts: DraftStore(storageURL: draftURL), submissions: try SubmissionStore(storageURL: attemptURL), writeStorageURL: journalURL)
            value.endpoint = network.endpoint.url.absoluteString; value.accessCode = "fixture"
            return value
        }
        let original = try store(); await original.connect(); original.setForeground(false)
        let key = DraftStore.key(project: "p", target: nil)
        original.drafts.setText("first", for: key)
        let accepted = await original.sendMessage(text: "first")
        XCTAssertFalse(accepted)
        original.drafts.setText("later edit", for: key)
        original.drafts.addFile(Attachment(id: "kept", url: "/uploads/kept"), for: key)
        original.disconnect()
        let restarted = try store(); await restarted.connect(); restarted.setForeground(false)
        defer { restarted.disconnect() }
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        XCTAssertEqual(restarted.drafts.text(for: key), "later edit")
        XCTAssertEqual(restarted.drafts.files(for: key).map(\.id), ["kept"])
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        let attempts = try SubmissionStore(storageURL: attemptURL)
        XCTAssertEqual(attempts.messageAttempt(id: id)?.status, .accepted)
        await network.close()
    }
}
