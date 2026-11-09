import Foundation
import Observation

struct PushSystemSettings: Sendable, Equatable {
    let authorization: PushAuthorization
    let alertsEnabled: Bool
    let soundsEnabled: Bool
}

@MainActor protocol PushAuthorizationProvider: AnyObject {
    var onToken: (@MainActor @Sendable (Data, UUID) -> Void)? { get set }
    var onFailure: (@MainActor @Sendable (UUID) -> Void)? { get set }
    func settings() async -> PushSystemSettings
    func requestAuthorization() async throws
    /// OS callbacks have no request ID: implementations must serialize outstanding registrations.
    func register(generation: UUID) -> Bool
    func cancelPendingRegistration()
    func clearDelivered(serverID: String) async
    /// nil means there is no foreground surface to present the one-time invitation.
    func offerNotificationSetup() async -> Bool?
}

extension PushAuthorizationProvider {
    func offerNotificationSetup() async -> Bool? { nil }
}

enum PushRegistrationState: Equatable {
    case disabled, needsHost, requestingPermission, denied, registering, awaitingHost
    case enabled, requiresOptIn, revocationPending, unsupported, failed
}

/// The persisted representation deliberately has no token, access code, or API client.
private struct PushLocalState: Codable {
    struct Host: Codable {
        var endpoint: String
        var optedIn = false
        var revocationPending = false
        var disablePending: Bool? = nil
    }
    var installationID = UUID().uuidString.lowercased()
    var hosts: [String: Host] = [:]
    var notificationSetupOffered: Bool? = nil
}

@MainActor @Observable
final class PushNotificationService {
    let settingsStore: PushSettingsStore
    private(set) var state: PushRegistrationState = .disabled
    private(set) var systemSettings: PushSystemSettings?
    private(set) var generation = UUID()
    var installationID: String { local.installationID }
    var pendingRevocations: [String] { local.hosts.filter { $0.value.revocationPending }.map(\.key).sorted() }
    @ObservationIgnored private let provider: any PushAuthorizationProvider
    @ObservationIgnored private let environment: PushEnvironment
    @ObservationIgnored private let defaults: UserDefaults?
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var local: PushLocalState
    @ObservationIgnored private var token: Data?
    @ObservationIgnored private var enabling: UUID?
    @ObservationIgnored private var enableRevision: Int?
    @ObservationIgnored private var operation: UUID?
    @ObservationIgnored private var deferredToken = false
    @ObservationIgnored private var offeringSetup = false
    @ObservationIgnored private var uploaded: (token: Data, at: Date)?
    private static let persistenceKey = "iamceo.push.registration.v1"

    init(provider: any PushAuthorizationProvider, environment: PushEnvironment, defaults: UserDefaults? = .standard,
         settingsStore: PushSettingsStore? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider; self.environment = environment; self.defaults = defaults; self.now = now
        self.settingsStore = settingsStore ?? PushSettingsStore()
        if let data = defaults?.data(forKey: Self.persistenceKey), let saved = try? JSONDecoder().decode(PushLocalState.self, from: data),
           UUID(uuidString: saved.installationID) != nil { local = saved }
        else { local = PushLocalState() }
        persist()
        provider.onToken = { [weak self] data, id in Task { await self?.receiveToken(data, generation: id) } }
        provider.onFailure = { [weak self] id in self?.registrationFailed(generation: id) }
    }

    /// Call only with an endpoint confirmed by the existing connection flow.
    func setHost(_ host: PushHostContext?) {
        provider.cancelPendingRegistration()
        generation = UUID(); operation = nil; enabling = nil; enableRevision = nil; token = nil; uploaded = nil; deferredToken = false
        settingsStore.setHost(host)
        guard let host, !host.isDemo else { state = .needsHost; return }
        let key = host.serverID.lowercased()
        let previous = local.hosts[key]
        local.hosts[key] = previous ?? PushLocalState.Host(endpoint: host.endpoint.url.absoluteString)
        local.hosts[key]?.endpoint = host.endpoint.url.absoluteString
        persist()
        state = local.hosts[key]?.revocationPending == true ? .revocationPending : .disabled
    }

    /// Launch/reconnect/foreground hook. The invitation requests OS permission only after an explicit "지금 켜기".
    func foreground() async {
        guard let key = hostKey else { state = .needsHost; return }
        let id = generation
        if local.hosts[key]?.revocationPending == true { await revoke(); return }
        if local.hosts[key]?.disablePending == true { await disable(); return }
        guard local.hosts[key]?.optedIn == true else {
            state = .disabled
            guard local.notificationSetupOffered != true, !offeringSetup, environment != .unknown else { return }
            offeringSetup = true
            let choice = await provider.offerNotificationSetup()
            offeringSetup = false
            guard let choice else { return }
            local.notificationSetupOffered = true; persist()
            guard valid(id) else { return }
            if choice { await enable() }
            return
        }
        guard environment != .unknown else { state = .unsupported; return }
        guard operation == nil else { return }
        operation = id
        defer { finishOperation(id) }
        let current = await provider.settings()
        guard valid(id) else { return }
        systemSettings = current
        do {
            try await settingsStore.refresh()
            guard valid(id) else { return }
            if systemSettings?.authorization.permitsNotifications != true {
                if settingsStore.device(id: installationID) != nil {
                    let authorization = systemSettings?.authorization == .unknown ? nil : systemSettings?.authorization
                    try await settingsStore.patch(id: installationID, enabled: false, authorization: authorization)
                }
                guard valid(id) else { return }
                state = .denied
                return
            }
            if let device = settingsStore.device(id: installationID), device.state != .active {
                state = .requiresOptIn
                return
            }
            if let token {
                try await upload(token, id: id, explicit: enabling == id)
            } else {
                state = .registering
                if !provider.register(generation: id) { state = .awaitingHost }
            }
        } catch { fail(error, id: id) }
    }

    /// The sole permission prompt and sole automatic enabled=true path, triggered by a user action.
    func enable() async {
        guard let key = hostKey else { state = .needsHost; return }
        guard operation == nil else { return }
        if local.hosts[key]?.revocationPending == true { await revoke(); return }
        if local.hosts[key]?.disablePending == true { await disable(); return }
        guard environment != .unknown else { state = .unsupported; return }
        generation = UUID(); let id = generation
        operation = id; enabling = id; uploaded = nil
        local.hosts[key]?.optedIn = true; persist()
        defer { finishOperation(id) }
        do {
            var current = await provider.settings()
            guard valid(id) else { return }
            if current.authorization == .notDetermined {
                state = .requestingPermission
                try await provider.requestAuthorization()
                guard valid(id) else { return }
                current = await provider.settings()
            }
            guard valid(id) else { return }
            systemSettings = current
            guard current.authorization.permitsNotifications else { enabling = nil; state = .denied; return }
            try await settingsStore.refresh()
            guard valid(id) else { return }
            enableRevision = settingsStore.device(id: installationID)?.revision
            state = .registering
            if !provider.register(generation: id) { state = .awaitingHost }
        } catch { fail(error, id: id) }
    }

    func receiveToken(_ data: Data, generation id: UUID) async {
        guard valid(id), let key = hostKey, local.hosts[key]?.optedIn == true,
              local.hosts[key]?.revocationPending != true,
              !data.isEmpty, data.count <= 512 else { return }
        token = data
        // A callback can arrive before the initiating hook returns. Drain it after that operation.
        guard operation == nil else { deferredToken = true; state = .awaitingHost; return }
        operation = id
        defer { finishOperation(id) }
        do {
            let current = await provider.settings()
            guard valid(id) else { return }
            systemSettings = current
            guard systemSettings?.authorization.permitsNotifications == true else { state = .denied; return }
            try await upload(data, id: id, explicit: enabling == id)
        } catch { fail(error, id: id) }
    }

    func registrationFailed(generation id: UUID) {
        guard valid(id) else { return }
        token = nil; state = .failed
    }

    func disable() async {
        guard let key = hostKey else { state = .needsHost; return }
        generation = UUID(); let id = generation
        enabling = nil; operation = id; token = nil; uploaded = nil; deferredToken = false
        provider.cancelPendingRegistration()
        settingsStore.setHost(settingsStore.host)
        local.hosts[key]?.optedIn = false; local.hosts[key]?.disablePending = true; persist()
        defer { finishOperation(id) }
        do {
            _ = try await settingsStore.fetchDevice(id: installationID)
            guard valid(id) else { return }
            if settingsStore.device(id: installationID) != nil { try await settingsStore.patch(id: installationID, enabled: false) }
            guard valid(id) else { return }
            local.hosts[key]?.disablePending = false; persist()
            state = .disabled
        } catch { fail(error, id: id) }
    }

    /// Used before logout. Failure leaves a persisted marker; credentials need not be retained.
    func revoke() async {
        guard let key = hostKey else { state = .needsHost; return }
        generation = UUID(); let id = generation
        operation = id; enabling = nil; token = nil; uploaded = nil; deferredToken = false
        settingsStore.setHost(settingsStore.host)
        local.hosts[key]?.optedIn = false; local.hosts[key]?.revocationPending = true; persist()
        state = .revocationPending
        // Revocation belongs to this host. APNs registration is app-wide and may serve other hosts.
        provider.cancelPendingRegistration()
        defer { finishOperation(id) }
        do {
            _ = try await settingsStore.fetchDevice(id: installationID)
            guard valid(id) else { return }
            try await settingsStore.revoke(id: installationID)
            guard valid(id) else { return }
            local.hosts[key]?.revocationPending = false; local.hosts[key]?.disablePending = false; persist()
            await provider.clearDelivered(serverID: key)
            guard valid(id) else { return }
            state = .disabled
        } catch { if valid(id) { state = .revocationPending } }
    }

    private func upload(_ data: Data, id: UUID, explicit: Bool) async throws {
        guard valid(id), let authorization = systemSettings?.authorization, authorization.permitsNotifications else { return }
        let current = try await settingsStore.fetchDevice(id: installationID)
        guard valid(id) else { return }
        if explicit, current?.revision != enableRevision {
            enabling = nil
            state = .requiresOptIn
            return
        }
        if !explicit, let current, current.state != .active { state = .requiresOptIn; return }
        if !explicit, let uploaded, uploaded.token == data, now().timeIntervalSince(uploaded.at) >= 0,
           now().timeIntervalSince(uploaded.at) < 86_400, let current, current.authorization == authorization,
           current.environment == environment, current.bundleId == PushContract.bundleID {
            state = current.enabled == true ? .enabled : .disabled
            return
        }
        let request = PushRegistrationRequest(expectedRevision: current?.revision, environment: environment,
                                              deviceToken: data.map { String(format: "%02x", $0) }.joined(), authorization: authorization)
        state = .awaitingHost
        let registered = try await settingsStore.register(id: installationID, request: request)
        guard valid(id) else { return }
        uploaded = (data, now())
        if explicit {
            // Consume the explicit action before sending. An uncertain PATCH is never replayed.
            enabling = nil
            let enabled = try await settingsStore.patch(id: installationID, enabled: true)
            guard valid(id) else { return }
            state = enabled.enabled == true ? .enabled : .disabled
        } else { state = registered.enabled == true ? .enabled : .disabled }
    }

    private var hostKey: String? {
        guard let host = settingsStore.host, !host.isDemo else { return nil }
        return host.serverID.lowercased()
    }
    private func valid(_ id: UUID) -> Bool { generation == id && hostKey != nil }
    private func finishOperation(_ id: UUID) {
        guard generation == id else { return }
        operation = nil
        if deferredToken, let token {
            deferredToken = false
            Task { await receiveToken(token, generation: id) }
        }
    }
    private func fail(_ error: any Error, id: UUID) {
        guard valid(id) else { return }
        if (error as? PushSettingsError) == .unsupported { state = .unsupported }
        else { state = token == nil ? .failed : .awaitingHost }
        // Refreshing/retrying a registration may proceed later; enabling requires a fresh action.
        enabling = nil
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(local) { defaults?.set(data, forKey: Self.persistenceKey) }
    }

    static func environment(infoValue: String?) -> PushEnvironment {
        switch infoValue { case "development": .sandbox; case "production": .production; default: .unknown }
    }
}
