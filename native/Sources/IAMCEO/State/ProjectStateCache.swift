import Foundation

/// The payload is stored as bounded Data, so the inactive cache has a real byte ceiling,
/// independent of the number or size of file bodies in a ProjectState. Never persisted to disk.
struct ProjectStateCache {
    let countLimit: Int
    let byteLimit: Int
    private var entries: [String: Data] = [:]
    private var recency: [String] = []
    private(set) var byteCount = 0
    var count: Int { entries.count }
    init(countLimit: Int = 4, byteLimit: Int = 8 * 1024 * 1024) {
        self.countLimit = max(0, countLimit); self.byteLimit = max(0, byteLimit)
    }
    private func key(_ id: String, _ archived: Bool) -> String { "\(archived):\(id)" }
    /// Shared by the app and tests; generic so an Encodable probe can verify the actual executor.
    static func encode<Value: Encodable & Sendable>(_ value: Value) async -> Data? {
        await Task.detached(priority: .utility) { try? JSONEncoder().encode(value) }.value
    }
    mutating func insert(_ state: ProjectState) async {
        let encoded = await Self.encode(state)
        insert(state, encoded: encoded)
    }
    mutating func insert(_ state: ProjectState, encoded data: Data?) {
        let key = key(state.project.id, state.project.archived)
        removeKey(key)
        guard countLimit > 0, let data, data.count <= byteLimit else { return }
        while entries.count >= countLimit || byteCount + data.count > byteLimit {
            guard let victim = recency.first else { break }
            removeKey(victim)
        }
        entries[key] = data; byteCount += data.count; recency.append(key)
    }
    mutating func value(projectID: String, archived: Bool) -> ProjectState? {
        let key = key(projectID, archived)
        guard let data = entries[key], let state = try? JSONDecoder().decode(ProjectState.self, from: data) else { return nil }
        recency.removeAll { $0 == key }; recency.append(key)
        return state
    }
    mutating func remove(projectID: String) { removeKey(key(projectID, false)); removeKey(key(projectID, true)) }
    private mutating func removeKey(_ key: String) {
        if let data = entries.removeValue(forKey: key) { byteCount -= data.count }
        recency.removeAll { $0 == key }
    }
    mutating func removeAll() { entries = [:]; recency = []; byteCount = 0 }
}
