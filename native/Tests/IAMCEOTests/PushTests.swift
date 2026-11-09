import Foundation
import XCTest
@testable import IAMCEO

private actor MockPushAPI: PushService {
    let serverID: String
    var devices: [String: PushDevice] = [:]
    var registrations: [PushRegistrationRequest] = []
    var patches: [PushDevicePatchRequest] = []
    var revocations = 0
    var failure: Int?
    var holdRegistration = false
    var held: TestDeadlineContinuation<Void, Never>?
    init(_ serverID: String) { self.serverID = serverID }
    func setFailure(_ value: Int?) { failure = value }
    func setHoldRegistration() { holdRegistration = true }
    func releaseRegistration() { holdRegistration = false; held?.resume(); held = nil }
    func seed(_ device: PushDevice) { devices[device.id] = device }
    private func check() throws { if let failure { throw APIError(status: failure, message: "private-canary-token") } }
    func pushStatus() throws -> PushStatus { try check(); return PushStatus(serverId: serverID, supported: true, providers: []) }
    func pushDevices() throws -> PushDeviceList { try check(); return PushDeviceList(devices: Array(devices.values)) }
    func pushDevice(id: String) throws -> PushDevice {
        try check()
        guard let device = devices[id] else { throw APIError(status: 404, message: "missing") }
        return device
    }
    func registerPushDevice(id: String, request: PushRegistrationRequest) async throws -> PushDevice {
        try check(); registrations.append(request)
        if holdRegistration { await withTestDeadline(fallback: ()) { held = $0 } }
        let old = devices[id]
        guard request.expectedRevision == old?.revision else { throw APIError(status: 409, message: "changed") }
        let device = PushDevice(id: id, platform: "ios", bundleId: PushContract.bundleID, environment: request.environment,
                                enabled: old?.state == .active ? old?.enabled ?? false : false,
                                authorization: request.authorization, preferences: old?.preferences ?? PushPreferences(), state: .active,
                                revision: (old?.revision ?? 0) + 1)
        devices[id] = device
        return device
    }
    func patchPushDevice(id: String, request: PushDevicePatchRequest) throws -> PushDevice {
        try check(); patches.append(request)
        guard var device = devices[id], device.revision == request.expectedRevision else { throw APIError(status: 409, message: "changed") }
        if let enabled = request.enabled { device.enabled = enabled }
        if let authorization = request.authorization { device.authorization = authorization }
        if let preferences = request.preferences {
            var current = device.preferences ?? PushPreferences()
            if let value = preferences.decision { current.decision = value }
            if let value = preferences.approvalWait { current.approvalWait = value }
            if let value = preferences.error { current.error = value }
            if let value = preferences.reportComplete { current.reportComplete = value }
            if let value = preferences.todoCreated { current.todoCreated = value }
            if let value = preferences.reportBlocked { current.reportBlocked = value }
            device.preferences = current
        }
        device.revision = (device.revision ?? 0) + 1; devices[id] = device
        return device
    }
    func revokePushDevice(id: String, revision: Int) throws {
        try check(); revocations += 1
        if let old = devices[id], old.state != .revoked, old.revision != revision { throw APIError(status: 409, message: "changed") }
        devices[id] = PushDevice(id: id, enabled: false, state: .revoked, revision: revision + 1)
    }
    func testPushDevice(id: String, request: PushTestRequest) throws -> PushTestResult {
        try check(); return PushTestResult(notificationId: request.requestId, state: .queued)
    }
    func pushTarget(eventID: String) throws -> PushEventTarget {
        try check(); return PushEventTarget(serverId: serverID, eventId: eventID, target: .home, reportGroup: nil)
    }
}

@MainActor private final class MockPushOS: PushAuthorizationProvider {
    var onToken: (@MainActor @Sendable (Data, UUID) -> Void)?
    var onFailure: (@MainActor @Sendable (UUID) -> Void)?
    var current = PushSystemSettings(authorization: .notDetermined, alertsEnabled: false, soundsEnabled: false)
    var grant = true
    var prompts = 0
    var reads = 0
    var registrations: [UUID] = []
    var cleared: [String] = []
    var synchronousToken: Data?
    var holdPermission = false
    var permissionWaiter: TestDeadlineContinuation<Void, Never>?
    func settings() -> PushSystemSettings { reads += 1; return current }
    func requestAuthorization() async {
        prompts += 1
        if holdPermission { await withTestDeadline(fallback: ()) { permissionWaiter = $0 } }
        current = PushSystemSettings(authorization: grant ? .authorized : .denied, alertsEnabled: grant, soundsEnabled: grant)
    }
    func releasePermission() { holdPermission = false; permissionWaiter?.resume(); permissionWaiter = nil }
    func register(generation: UUID) -> Bool {
        registrations.append(generation)
        if let synchronousToken { onToken?(synchronousToken, generation) }
        return true
    }
    func cancelPendingRegistration() {}
    func clearDelivered(serverID: String) { cleared.append(serverID) }
}

/// In-memory UserDefaults injection: no standard preferences or on-disk suite writes.
private final class MemoryPushDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    override func data(forKey defaultName: String) -> Data? { lock.withLock { values[defaultName] } }
    override func set(_ value: Any?, forKey defaultName: String) { lock.withLock { values[defaultName] = value as? Data } }
    var bytes: Data { lock.withLock { values.values.reduce(into: Data()) { $0.append($1) } } }
}

private final class PushTestDate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value.addTimeInterval(seconds) } }
}

@MainActor
final class PushTests: XCTestCase {
    private let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
    private func host(_ api: MockPushAPI, demo: Bool = false) throws -> PushHostContext {
        PushHostContext(serverID: server, endpoint: try ServerEndpoint("https://fixture.invalid"), service: api, isDemo: demo)
    }
    private func eventually(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1000 {
            if await predicate() { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Condition did not settle", file: file, line: line)
    }

    func testExplicitOptInVariableLengthHexAndSixDefaults() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api))
        await service.foreground()
        XCTAssertEqual(os.prompts, 0); XCTAssertTrue(os.registrations.isEmpty)
        await service.enable()
        XCTAssertEqual(os.prompts, 1); XCTAssertEqual(os.registrations.count, 1)
        await service.receiveToken(Data([0, 15, 255]), generation: service.generation)
        XCTAssertEqual(service.state, .enabled)
        let request = await api.registrations.first
        XCTAssertEqual(request?.deviceToken, "000fff"); XCTAssertNil(request?.expectedRevision)
        let device = try await api.pushDevice(id: service.installationID)
        XCTAssertEqual(device.preferences, PushPreferences())
        XCTAssertTrue(device.preferences?.reportComplete == true)
        XCTAssertTrue(device.preferences?.todoCreated == true); XCTAssertTrue(device.preferences?.reportBlocked == true)
        XCTAssertEqual(device.bundleId, "com.yehsung.iamceo")
        XCTAssertEqual(service.systemSettings?.soundsEnabled, true)
    }

    func testDeniedAndDemoNeverRegisterOrPromptOnForeground() async throws {
        let api = MockPushAPI(server); let os = MockPushOS(); os.grant = false
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable(); await service.foreground()
        XCTAssertEqual(service.state, .denied); XCTAssertEqual(os.prompts, 1); XCTAssertTrue(os.registrations.isEmpty)
        service.setHost(try host(api, demo: true)); await service.enable(); await service.foreground()
        XCTAssertEqual(os.prompts, 1)
        let registrations = await api.registrations.count; XCTAssertEqual(registrations, 0)
    }

    func testLatePermissionAndTokenCallbacksCannotCrossHosts() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        let old = service.generation
        let otherID = UUID().uuidString.lowercased(); let other = MockPushAPI(otherID)
        service.setHost(PushHostContext(serverID: otherID, endpoint: try ServerEndpoint("https://other.invalid"), service: other))
        await service.receiveToken(Data([1, 2]), generation: old)
        service.registrationFailed(generation: old)
        XCTAssertEqual(service.state, .disabled)
        let a = await api.registrations.count; let b = await other.registrations.count
        XCTAssertEqual(a, 0); XCTAssertEqual(b, 0)
        await service.enable()
        await service.receiveToken(Data([3, 4]), generation: service.generation)
        XCTAssertEqual(service.state, .enabled)
    }

    func testTokenIsMemoryOnlyAndInstallationIntentSurviveRestart() async throws {
        let defaults = MemoryPushDefaults(); let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: defaults)
        service.setHost(try host(api)); await service.enable()
        await service.receiveToken(Data([0xde, 0xad, 0xbe, 0xef]), generation: service.generation)
        let saved = String(decoding: defaults.bytes, as: UTF8.self)
        XCTAssertFalse(saved.contains("deadbeef")); XCTAssertFalse(saved.contains("deviceToken")); XCTAssertFalse(saved.contains("private-canary"))
        let newOS = MockPushOS(); newOS.current = os.current
        let restored = PushNotificationService(provider: newOS, environment: .sandbox, defaults: defaults)
        XCTAssertEqual(restored.installationID, service.installationID)
        restored.setHost(try host(api)); await restored.foreground()
        XCTAssertEqual(newOS.registrations.count, 1); XCTAssertEqual(newOS.prompts, 0)
        let uploads = await api.registrations.count; XCTAssertEqual(uploads, 1)
    }

    func testOfflineTokenRetriedAndServerOptOutNeverReenabled() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        await api.setFailure(503)
        await service.receiveToken(Data([1, 2]), generation: service.generation)
        XCTAssertEqual(service.state, .awaitingHost)
        await api.setFailure(nil); await service.foreground()
        XCTAssertEqual(service.state, .disabled) // uncertain action never replays enabled PATCH
        var device = try await api.pushDevice(id: service.installationID)
        device.state = .revoked; device.enabled = false; device.revision = 10
        await api.seed(device)
        let before = await api.registrations.count
        await service.foreground()
        XCTAssertEqual(service.state, .requiresOptIn)
        let after = await api.registrations.count; XCTAssertEqual(before, after)
    }

    func testOfflineRevocationMarkerSurvivesRestartAndRunsBeforeRegistration() async throws {
        let defaults = MemoryPushDefaults(); let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: defaults)
        service.setHost(try host(api)); await service.enable()
        await service.receiveToken(Data([1]), generation: service.generation)
        await api.setFailure(503); await service.revoke()
        XCTAssertEqual(service.state, .revocationPending); XCTAssertEqual(service.pendingRevocations, [server])
        service.setHost(nil)
        let restored = PushNotificationService(provider: MockPushOS(), environment: .sandbox, defaults: defaults)
        restored.setHost(try host(api)); await api.setFailure(nil); await restored.foreground()
        XCTAssertEqual(restored.state, .disabled); XCTAssertTrue(restored.pendingRevocations.isEmpty)
        let device = try await api.pushDevice(id: restored.installationID); XCTAssertEqual(device.state, .revoked)
        let uploads = await api.registrations.count; XCTAssertEqual(uploads, 1)
    }

    func testDailyRenewalPermissionWithdrawalAndRemoteDisabledState() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .production, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        await service.receiveToken(Data([7]), generation: service.generation)
        await service.foreground(); await service.foreground()
        var requests = await api.registrations.count; XCTAssertEqual(requests, 1)
        var device = try await api.pushDevice(id: service.installationID)
        device.enabled = false; device.revision = 10; await api.seed(device)
        await service.foreground(); XCTAssertEqual(service.state, .disabled)
        requests = await api.registrations.count; XCTAssertEqual(requests, 1)
        os.current = PushSystemSettings(authorization: .denied, alertsEnabled: false, soundsEnabled: false)
        await service.foreground()
        let denied = try await api.pushDevice(id: service.installationID)
        XCTAssertEqual(denied.authorization, .denied); XCTAssertEqual(denied.enabled, false)
        XCTAssertEqual(os.prompts, 1)
    }

    func testLateRegistrationResponseAndUnsupportedAPIStayIndependent() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        await api.setHoldRegistration()
        let registration = Task { await service.receiveToken(Data([9]), generation: service.generation) }
        await eventually { await api.registrations.count == 1 }
        service.setHost(nil)
        await api.releaseRegistration(); await registration.value
        XCTAssertEqual(service.state, .needsHost); XCTAssertTrue(service.settingsStore.devices.isEmpty)
        let patches = await api.patches.count; XCTAssertEqual(patches, 0)
        await api.setFailure(404); service.setHost(try host(api)); await service.enable()
        XCTAssertEqual(service.state, .unsupported)
        XCTAssertEqual(service.settingsStore.error, .unsupported)
    }


    func testNewPreferencesPatchOnlyOneKindAndTokenReregistrationPreservesChoices() async throws {
        let api = MockPushAPI(server), store = PushSettingsStore()
        store.setHost(try host(api))
        let id = UUID().uuidString
        await api.seed(PushDevice(id: id, enabled: false, authorization: .authorized,
            preferences: PushPreferences(), state: .active, revision: 1))
        try await store.refresh()
        _ = try await store.patch(id: id, preferences: PushPreferencesPatch(todoCreated: false))
        _ = try await store.patch(id: id, preferences: PushPreferencesPatch(reportBlocked: false))
        let patches = await api.patches
        for (index, key) in ["todo_created", "report_blocked"].enumerated() {
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patches[index])) as? [String: Any])
            XCTAssertEqual(json["preferences"] as? [String: Bool], [key: false])
            XCTAssertNil(json["enabled"])
        }
        let updated = try await api.registerPushDevice(id: id, request: PushRegistrationRequest(
            expectedRevision: 3, environment: .sandbox, deviceToken: "00", authorization: .authorized))
        XCTAssertEqual(updated.enabled, false)
        XCTAssertEqual(updated.preferences, PushPreferences(todoCreated: false, reportBlocked: false))
    }

    func testSettingsPartialPatchConflictAndTestReceipt() async throws {
        let api = MockPushAPI(server); let store = PushSettingsStore(); store.setHost(try host(api))
        let id = UUID().uuidString
        await api.seed(PushDevice(id: id, enabled: true, preferences: PushPreferences(), state: .active, revision: 1))
        try await store.refresh()
        _ = try await store.patch(id: id, preferences: PushPreferencesPatch(reportComplete: false))
        XCTAssertEqual(store.device(id: id)?.preferences?.reportComplete, false)
        XCTAssertEqual(store.device(id: id)?.preferences?.decision, true)
        await api.seed(PushDevice(id: id, enabled: false, state: .revoked, revision: 4))
        do { _ = try await store.patch(id: id, enabled: true); XCTFail("CAS conflict") }
        catch { XCTAssertEqual(error as? PushSettingsError, .conflict) }
        XCTAssertEqual(store.device(id: id)?.revision, 2)
        let test = try await store.sendTest(id: id, requestID: UUID().uuidString)
        XCTAssertEqual(test.state, .queued)
        XCTAssertEqual(PushNotificationService.environment(infoValue: "development"), .sandbox)
        XCTAssertEqual(PushNotificationService.environment(infoValue: "production"), .production)
        XCTAssertEqual(PushNotificationService.environment(infoValue: "Debug"), .unknown)
    }

    func testPermissionResultAfterHostSwitchIsDiscarded() async throws {
        let api = MockPushAPI(server); let os = MockPushOS(); os.holdPermission = true
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api))
        let enable = Task { await service.enable() }
        await eventually { os.permissionWaiter != nil }
        service.setHost(nil); os.releasePermission(); await enable.value
        XCTAssertEqual(service.state, .needsHost); XCTAssertNil(service.systemSettings)
        XCTAssertTrue(os.registrations.isEmpty)
    }

    func testImmediateCallbackAndTokenReplacementDuringUploadAreDrained() async throws {
        let api = MockPushAPI(server); let os = MockPushOS(); os.synchronousToken = Data([1])
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await api.setHoldRegistration(); await service.enable()
        await eventually { await api.registrations.count == 1 }
        await service.receiveToken(Data([2]), generation: service.generation)
        await api.releaseRegistration()
        await eventually { await api.registrations.count == 2 }
        await eventually { service.state == .enabled }
        let requests = await api.registrations
        XCTAssertEqual(requests.map(\.deviceToken), ["01", "02"])
        let patches = await api.patches.count; XCTAssertEqual(patches, 1)
    }

    func testDailyRenewalBoundaryAndOfflineDisableRetry() async throws {
        let clock = PushTestDate(); let defaults = MemoryPushDefaults(); let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: defaults, now: { clock.now() })
        service.setHost(try host(api)); await service.enable()
        await service.receiveToken(Data([1]), generation: service.generation)
        clock.advance(86_399); await service.foreground()
        var uploads = await api.registrations.count; XCTAssertEqual(uploads, 1)
        clock.advance(1); await service.foreground()
        uploads = await api.registrations.count; XCTAssertEqual(uploads, 2)
        await api.setFailure(503); await service.disable()
        let stale = service.generation
        await service.receiveToken(Data([2]), generation: stale)
        let restored = PushNotificationService(provider: MockPushOS(), environment: .sandbox, defaults: defaults)
        restored.setHost(try host(api)); await api.setFailure(nil); await restored.foreground()
        let device = try await api.pushDevice(id: service.installationID)
        XCTAssertEqual(restored.state, .disabled); XCTAssertEqual(device.enabled, false)
    }

    func testRegistrationFailureAndUnknownEnvironmentCannotBecomeEnabled() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        service.registrationFailed(generation: service.generation)
        XCTAssertEqual(service.state, .failed)
        await service.foreground()
        XCTAssertEqual(os.registrations.count, 2); XCTAssertEqual(os.prompts, 1)
        let unknownOS = MockPushOS()
        let unknown = PushNotificationService(provider: unknownOS, environment: .unknown, defaults: nil)
        unknown.setHost(try host(api)); await unknown.enable()
        XCTAssertEqual(unknown.state, .unsupported); XCTAssertEqual(unknownOS.prompts, 0)
    }

    func testRevocationWhileWaitingForOSTokenRequiresNewUserAction() async throws {
        let api = MockPushAPI(server); let os = MockPushOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        service.setHost(try host(api)); await service.enable()
        await api.seed(PushDevice(id: service.installationID, enabled: false, state: .revoked, revision: 3))
        await service.receiveToken(Data([1]), generation: service.generation)
        XCTAssertEqual(service.state, .requiresOptIn)
        let requests = await api.registrations.count; XCTAssertEqual(requests, 0)
        let device = try await api.pushDevice(id: service.installationID); XCTAssertEqual(device.state, .revoked)
    }
}
