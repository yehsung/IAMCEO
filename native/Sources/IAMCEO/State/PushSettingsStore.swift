import Foundation
import Observation

struct PushHostContext: Sendable {
    let serverID: String
    let endpoint: ServerEndpoint
    let service: any PushService
    var isDemo = false
}

enum PushSettingsError: Error, Equatable {
    case unavailable, unsupported, hostChanged, invalidResponse, busy, conflict, requestFailed(Int)
}

/// Separate from application Settings and AppStore. Every await is fenced by the host generation.
@MainActor @Observable
final class PushSettingsStore {
    private(set) var host: PushHostContext?
    private(set) var generation = UUID()
    private(set) var status: PushStatus?
    private(set) var devices: [PushDevice] = []
    private(set) var error: PushSettingsError?
    private(set) var isLoading = false
    private(set) var pendingDevices: Set<String> = []
    @ObservationIgnored private var readID = UUID()

    func setHost(_ host: PushHostContext?) {
        generation = UUID(); readID = UUID()
        self.host = host
        status = nil; devices = []; error = nil; isLoading = false; pendingDevices = []
    }

    func refresh() async throws {
        let (host, id) = try context()
        let read = UUID(); readID = read
        isLoading = true
        defer { if generation == id, readID == read { isLoading = false } }
        do {
            let status: PushStatus
            do { status = try await host.service.pushStatus() }
            catch let error as APIError where error.status == 404 { throw PushSettingsError.unsupported }
            try check(id)
            guard status.serverId.lowercased() == host.serverID.lowercased() else { throw PushSettingsError.invalidResponse }
            guard status.supported else { throw PushSettingsError.unsupported }
            let list = try await host.service.pushDevices()
            try check(id)
            guard readID == read else { return }
            guard Set(list.devices.map(\.id)).count == list.devices.count else { throw PushSettingsError.invalidResponse }
            self.status = status
            // A read begun before a mutation cannot erase its newer revision.
            devices = list.devices.map { incoming in
                if let current = device(id: incoming.id), (current.revision ?? 0) > (incoming.revision ?? 0) { return current }
                return incoming
            } + devices.filter { current in pendingDevices.contains(current.id) && !list.devices.contains(where: { $0.id == current.id }) }
            self.error = nil
        } catch { throw record(error, generation: id) }
    }

    func device(id: String) -> PushDevice? { devices.first { $0.id == id } }

    @discardableResult func fetchDevice(id deviceID: String) async throws -> PushDevice? {
        let (host, id) = try context()
        let read = readID
        do {
            let result = try await host.service.pushDevice(id: deviceID)
            try check(id)
            guard read == readID else { return device(id: deviceID) }
            try accept(result, expectedID: deviceID)
            return result
        } catch let error as APIError where error.status == 404 {
            try check(id)
            guard read == readID else { return device(id: deviceID) }
            devices.removeAll { $0.id == deviceID }
            return nil
        } catch { throw record(error, generation: id) }
    }

    @discardableResult func register(id deviceID: String, request: PushRegistrationRequest) async throws -> PushDevice {
        try await mutate(deviceID) { try await $0.registerPushDevice(id: deviceID, request: request) }
    }

    @discardableResult func patch(id deviceID: String, enabled: Bool? = nil, preferences: PushPreferencesPatch? = nil,
                                  label: String? = nil, authorization: PushAuthorization? = nil) async throws -> PushDevice {
        guard let revision = device(id: deviceID)?.revision, revision > 0,
              enabled != nil || preferences != nil || label != nil || authorization != nil else { throw PushSettingsError.invalidResponse }
        let request = PushDevicePatchRequest(expectedRevision: revision, enabled: enabled, preferences: preferences, label: label, authorization: authorization)
        return try await mutate(deviceID) { try await $0.patchPushDevice(id: deviceID, request: request) }
    }

    func revoke(id deviceID: String) async throws {
        let (host, id) = try context()
        guard pendingDevices.insert(deviceID).inserted else { throw PushSettingsError.busy }
        defer { if generation == id { pendingDevices.remove(deviceID) } }
        do {
            // Even an absent first registration needs a DELETE tombstone to fence a late PUT.
            let revision = device(id: deviceID)?.revision ?? 1
            try await host.service.revokePushDevice(id: deviceID, revision: revision)
            try check(id)
            devices.removeAll { $0.id == deviceID }
            readID = UUID(); isLoading = false; error = nil
        } catch { throw record(error, generation: id) }
    }

    func sendTest(id deviceID: String, requestID: String) async throws -> PushTestResult {
        let (host, id) = try context()
        do {
            let result = try await host.service.testPushDevice(id: deviceID, request: PushTestRequest(requestId: requestID))
            try check(id)
            return result // queued is Apple submission pending, never a device delivery receipt.
        } catch { throw record(error, generation: id) }
    }

    private func mutate(_ deviceID: String, operation: (any PushService) async throws -> PushDevice) async throws -> PushDevice {
        let (host, id) = try context()
        guard pendingDevices.insert(deviceID).inserted else { throw PushSettingsError.busy }
        readID = UUID(); isLoading = false
        defer { if generation == id { pendingDevices.remove(deviceID) } }
        do {
            let result = try await operation(host.service)
            try check(id); try accept(result, expectedID: deviceID)
            error = nil
            return result
        } catch { throw record(error, generation: id) }
    }

    private func accept(_ device: PushDevice, expectedID: String) throws {
        guard device.id == expectedID, let revision = device.revision, revision > 0 else { throw PushSettingsError.invalidResponse }
        if let current = self.device(id: expectedID), (current.revision ?? 0) > revision { return }
        devices.removeAll { $0.id == expectedID }; devices.append(device)
    }

    private func context() throws -> (PushHostContext, UUID) {
        guard let host, !host.isDemo else { throw PushSettingsError.unavailable }
        return (host, generation)
    }
    private func check(_ id: UUID) throws { guard generation == id else { throw PushSettingsError.hostChanged } }
    private func record(_ error: any Error, generation id: UUID) -> PushSettingsError {
        guard generation == id else { return .hostChanged }
        let safe = (error as? PushSettingsError) ?? ((error as? APIError)?.status == 409 ? .conflict : .requestFailed((error as? APIError)?.status ?? 0))
        self.error = safe
        return safe
    }
}
