import Foundation
import Observation

/// Shared persistence boundary. Tests inject a file URL (or disable persistence), never the user's defaults.
struct LocalStateStorage {
    let enabled: Bool
    let url: URL?
    let defaults: UserDefaults
    let key: String

    func read<T: Decodable>(_ type: T.Type) throws -> T? {
        guard enabled else { return nil }
        let data: Data?
        if let url {
            data = FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
        } else { data = defaults.data(forKey: key) }
        return try data.map { try JSONDecoder().decode(type, from: $0) }
    }

    func write<T: Encodable>(_ value: T) throws {
        guard enabled else { return }
        let data = try JSONEncoder().encode(value)
        if let url {
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
            #else
            try data.write(to: url, options: .atomic)
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.synchronize()
        } else {
            defaults.set(data, forKey: key)
            guard defaults.synchronize() else { throw CocoaError(.fileWriteUnknown) }
        }
    }
}

struct DraftSnapshot: Codable, Sendable {
    let namespace: String
    let key: String
    let generation: UUID
    let revision: Int
    let textRevision: Int
    let text: String
    let attachments: [Attachment]
    let attachmentRevisions: [String: Int]
}

struct DraftUploadToken: Sendable {
    let namespace: String
    let connectionGeneration: UUID
    let key: String
    let draftGeneration: UUID
}

struct DraftUploadFailure: Codable, Identifiable {
    let id: UUID
    let name: String
    let detail: String
    // Optional so older notices remain readable; a display name alone cannot identify an original.
    let sourceID: String?
}

@MainActor @Observable
final class DraftStore {
    private struct EditorSession {
        let namespace: String
        let key: String
        let canRestore: () -> Bool
        let commit: () -> Void
        let synchronize: (DraftSnapshot) -> Void
        let moveCaretToEnd: () -> Void
    }
    @ObservationIgnored private var editors: [UUID: EditorSession] = [:]

    func registerEditor(id: UUID, key: String, canRestore: @escaping () -> Bool,
                        commit: @escaping () -> Void, synchronize: @escaping (DraftSnapshot) -> Void,
                        moveCaretToEnd: @escaping () -> Void = {}) {
        editors[id] = EditorSession(namespace: namespace, key: key, canRestore: canRestore,
                                    commit: commit, synchronize: synchronize, moveCaretToEnd: moveCaretToEnd)
    }
    func unregisterEditor(id: UUID) { editors.removeValue(forKey: id) }
    func commitEditors(for key: String) {
        for editor in Array(editors.values) where editor.namespace == namespace && editor.key == key { editor.commit() }
    }
    func moveEditorsCaretToEnd(for key: String) {
        for editor in Array(editors.values) where editor.namespace == namespace && editor.key == key { editor.moveCaretToEnd() }
    }
    private func synchronizeEditors(_ snapshot: DraftSnapshot) {
        for editor in Array(editors.values) where editor.namespace == snapshot.namespace && editor.key == snapshot.key {
            editor.synchronize(snapshot)
        }
    }
    func hasEditor(for sent: DraftSnapshot) -> Bool {
        editors.values.contains { $0.namespace == sent.namespace && $0.key == sent.key }
    }
    func canRestoreSubmission(_ sent: DraftSnapshot) -> Bool {
        let record = hosts[sent.namespace]?.records[sent.key]
        return (record?.text.isEmpty ?? true) && (record?.attachments.isEmpty ?? true)
            && editors.values.filter { $0.namespace == sent.namespace && $0.key == sent.key }.allSatisfy { $0.canRestore() }
    }
    func restoredSubmission(_ sent: DraftSnapshot, id: String) -> DraftSnapshot? {
        hosts[sent.namespace]?.handoffs?[id]?.restoredDraft
    }
    func matches(_ snapshot: DraftSnapshot) -> Bool {
        guard let record = hosts[snapshot.namespace]?.records[snapshot.key] else { return false }
        return record.generation == snapshot.generation && record.revision == snapshot.revision
    }
    func isCurrentGeneration(_ snapshot: DraftSnapshot) -> Bool {
        snapshot.namespace == namespace && hosts[snapshot.namespace]?.records[snapshot.key]?.generation == snapshot.generation
    }

    private struct Record: Codable {
        var text = ""
        var attachments: [Attachment] = []
        var revision = 0
        var textRevision = 0
        var attachmentRevisions: [String: Int] = [:]
        var generation = UUID()
        // Optional for compatibility with drafts saved before upload notices were persisted.
        var uploadFailures: [DraftUploadFailure]?
    }
    private struct Handoff: Codable {
        var restoredDraft: DraftSnapshot?
    }
    private struct Host: Codable {
        var records: [String: Record] = [:]
        var memos: [String: String] = [:]
        var handoffs: [String: Handoff]?
    }
    private(set) var namespace: String
    private(set) var connectionGeneration = UUID()
    private(set) var persistenceError: String?
    private var hosts: [String: Host] = [:]
    @ObservationIgnored private let storage: LocalStateStorage
    @ObservationIgnored private var canPersist = true

    init(persist: Bool = true, namespace: String = "unassigned", storageURL: URL? = nil, defaults: UserDefaults? = nil,
         persistMigration: Bool = true) {
        self.namespace = namespace
        storage = LocalStateStorage(enabled: persist, url: storageURL, defaults: defaults ?? .standard, key: "iamceo.drafts.v2")
        do {
            if let saved = try storage.read([String: Host].self) { hosts = saved }
            else if persist, storageURL == nil {
                // Legacy drafts have no proven host. Keep them quarantined until explicitly selected, never copy into a host.
                let source = defaults ?? .standard
                var legacy = Host()
                for (key, text) in source.dictionary(forKey: "iamceo.chatDrafts") as? [String: String] ?? [:] {
                    let parts = key.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    let migratedKey = parts.count == 2
                        ? Self.key(project: parts[0] == "none" ? nil : String(parts[0]), target: parts[1] == "chief" ? nil : String(parts[1]))
                        : key
                    legacy.records[migratedKey] = Record(text: text)
                }
                legacy.memos = source.dictionary(forKey: "iamceo.decisionMemos") as? [String: String] ?? [:]
                hosts["unassigned"] = legacy
                if persistMigration { save() }
            }
        } catch { persistenceError = error.localizedDescription; canPersist = false }
    }

    /// Length prefixes distinguish nil from literal IDs, and prevent delimiter collisions.
    static func key(project: String?, target: String?) -> String {
        [project, target].map { $0.map { "\($0.utf8.count):\($0)" } ?? "-" }.joined(separator: "|")
    }

    /// Use serverId plus repository generation when available; otherwise use a verified endpoint's canonical origin.
    static func endpointNamespace(_ endpoint: ServerEndpoint) -> String {
        var parts = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme?.lowercased()
        parts.host = parts.host?.lowercased()
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) { parts.port = nil }
        parts.path = ""
        return parts.string!
    }

    func selectNamespace(_ value: String) {
        namespace = value
        connectionGeneration = UUID() // A → B → A must also invalidate old callbacks.
    }

    var texts: [String: String] { (hosts[namespace]?.records ?? [:]).mapValues(\.text) }
    var attachments: [String: [Attachment]] { (hosts[namespace]?.records ?? [:]).mapValues(\.attachments) }
    var memos: [String: String] { hosts[namespace]?.memos ?? [:] }
    func text(for key: String) -> String { hosts[namespace]?.records[key]?.text ?? "" }
    func files(for key: String) -> [Attachment] { hosts[namespace]?.records[key]?.attachments ?? [] }
    func revision(for key: String) -> Int { hosts[namespace]?.records[key]?.revision ?? 0 }

    func setText(_ value: String, for key: String) {
        guard !value.utf8.elementsEqual(text(for: key).utf8) else { return }
        edit(key) { record in record.text = value; record.textRevision = record.revision }
    }
    func addFile(_ file: Attachment, for key: String) {
        guard !files(for: key).contains(where: { $0.id == file.id }) else { return }
        edit(key) { record in
            record.attachments.append(file)
            record.attachmentRevisions[file.id] = record.revision
        }
    }
    func removeFile(_ id: String, for key: String) {
        guard files(for: key).contains(where: { $0.id == id }) else { return }
        edit(key) { record in
            record.attachments.removeAll { $0.id == id }
            record.attachmentRevisions.removeValue(forKey: id)
        }
    }
    func clear(_ key: String) {
        edit(key) { record in
            record.text = ""; record.attachments = []; record.attachmentRevisions = [:]
            record.textRevision = record.revision; record.generation = UUID()
        }
    }
    func snapshot(for key: String) -> DraftSnapshot {
        if hosts[namespace]?.records[key] == nil { edit(key) { _ in } }
        let record = hosts[namespace]!.records[key]!
        return DraftSnapshot(namespace: namespace, key: key, generation: record.generation, revision: record.revision,
                             textRevision: record.textRevision, text: record.text, attachments: record.attachments,
                             attachmentRevisions: record.attachmentRevisions)
    }

    /// The draft change and its receipt share one atomic file write. Replaying after a crash is harmless.
    @discardableResult func detachSubmission(_ sent: DraftSnapshot, id: String) throws -> Bool {
        guard hosts[sent.namespace]?.handoffs?[id] == nil else { return false }
        let detached = try updateSubmission {
            var detached = false
            var record = hosts[sent.namespace]?.records[sent.key] ?? Record()
            if record.generation == sent.generation, record.revision == sent.revision {
                record.revision += 1
                record.text = ""; record.attachments = []; record.attachmentRevisions = [:]
                record.textRevision = record.revision
                record.generation = UUID()
                hosts[sent.namespace, default: Host()].records[sent.key] = record
                detached = true
            }
            if hosts[sent.namespace]?.handoffs == nil { hosts[sent.namespace, default: Host()].handoffs = [:] }
            hosts[sent.namespace]?.handoffs?[id] = Handoff()
            return detached
        }
        if detached {
            let record = hosts[sent.namespace]!.records[sent.key]!
            synchronizeEditors(DraftSnapshot(namespace: sent.namespace, key: sent.key, generation: record.generation,
                revision: record.revision, textRevision: record.textRevision, text: record.text,
                attachments: record.attachments, attachmentRevisions: record.attachmentRevisions))
        }
        return detached
    }

    /// Merges only when explicitly requested by the caller; SubmissionStore gates automatic restoration.
    @discardableResult func restoreSubmission(_ sent: DraftSnapshot, id: String) throws -> DraftSnapshot {
        if let restored = hosts[sent.namespace]?.handoffs?[id]?.restoredDraft { return restored }
        // A prepared intent may have crashed before the detach. Do not prepend an uncleared original.
        try detachSubmission(sent, id: id)
        let restored = try updateSubmission {
            var record = hosts[sent.namespace]?.records[sent.key] ?? Record()
            record.revision += 1
            if !sent.text.isEmpty {
                record.text = sent.text + (record.text.isEmpty ? "" : "\n\n" + record.text)
                record.textRevision = record.revision
            }
            let sentIDs = Set(sent.attachments.map(\.id))
            record.attachments = sent.attachments + record.attachments.filter { !sentIDs.contains($0.id) }
            for file in sent.attachments { record.attachmentRevisions[file.id] = record.revision }
            hosts[sent.namespace, default: Host()].records[sent.key] = record
            let restored = DraftSnapshot(namespace: sent.namespace, key: sent.key, generation: record.generation,
                                     revision: record.revision, textRevision: record.textRevision, text: record.text,
                                     attachments: record.attachments, attachmentRevisions: record.attachmentRevisions)
            hosts[sent.namespace]?.handoffs?[id] = Handoff(restoredDraft: restored)
            return restored
        }
        synchronizeEditors(restored)
        return restored
    }

    /// 지운 전송 기록의 인수 영수증만 지운다. 남은 기록의 영수증은 건드리지 않는다.
    func pruneHandoffs(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        var changed = false
        for host in Array(hosts.keys) {
            for id in ids where hosts[host]?.handoffs?.removeValue(forKey: id) != nil { changed = true }
        }
        if changed { save() }
    }

    private func updateSubmission<Value>(_ change: () -> Value) throws -> Value {
        guard canPersist else { throw APIError(status: 0, message: persistenceError ?? "초안을 저장하지 못했습니다") }
        let previous = hosts
        let result = change()
        do { try storage.write(hosts); persistenceError = nil; return result }
        catch {
            hosts = previous
            persistenceError = error.localizedDescription
            throw error
        }
    }

    /// Revision comparisons preserve even edit → undo, and remove/re-attach of the same ID.
    func consumeSent(_ sent: DraftSnapshot) {
        guard let record = hosts[sent.namespace]?.records[sent.key], record.generation == sent.generation else { return }
        var updated = record
        updated.revision += 1
        if record.textRevision == sent.textRevision {
            updated.text = ""; updated.textRevision = updated.revision
        }
        let ids = Set(sent.attachments.filter { record.attachmentRevisions[$0.id] == sent.attachmentRevisions[$0.id] }.map(\.id))
        updated.attachments.removeAll { ids.contains($0.id) }
        for id in ids { updated.attachmentRevisions.removeValue(forKey: id) }
        hosts[sent.namespace]?.records[sent.key] = updated
        save()
    }

    /// Legacy callers retain their previous behavior until the composer adopts captured revisions.
    func consumeSent(text sent: String, attachmentIDs: [String], for key: String) {
        edit(key) { record in
            if record.text == sent { record.text = ""; record.textRevision = record.revision }
            else if !sent.isEmpty, record.text.hasPrefix(sent) {
                record.text = String(record.text.dropFirst(sent.count).drop(while: \.isWhitespace))
                record.textRevision = record.revision
            }
            record.attachments.removeAll { attachmentIDs.contains($0.id) }
            for id in attachmentIDs { record.attachmentRevisions.removeValue(forKey: id) }
        }
    }

    func uploadToken(for key: String) -> DraftUploadToken {
        let sent = snapshot(for: key)
        return DraftUploadToken(namespace: namespace, connectionGeneration: connectionGeneration, key: key, draftGeneration: sent.generation)
    }
    func isCurrentUpload(_ token: DraftUploadToken) -> Bool {
        token.namespace == namespace && token.connectionGeneration == connectionGeneration
            && token.draftGeneration == hosts[namespace]?.records[token.key]?.generation
    }
    func uploadFailures(for key: String) -> [DraftUploadFailure] { hosts[namespace]?.records[key]?.uploadFailures ?? [] }
    func failUpload(name: String, token: DraftUploadToken, id: UUID = UUID(), sourceID: String? = nil, detail: String) {
        var record = hosts[token.namespace]?.records[token.key] ?? Record()
        var failures = record.uploadFailures ?? []
        failures.removeAll { $0.id == id }
        failures.append(DraftUploadFailure(id: id, name: name, detail: detail, sourceID: sourceID))
        record.uploadFailures = failures
        hosts[token.namespace, default: Host()].records[token.key] = record
        save()
    }
    func resolveUploadFailures(sourceID: String?, token: DraftUploadToken) {
        guard let sourceID, isCurrentUpload(token),
              let failures = hosts[token.namespace]?.records[token.key]?.uploadFailures,
              failures.contains(where: { $0.sourceID == sourceID }) else { return }
        hosts[token.namespace]?.records[token.key]?.uploadFailures = failures.filter { $0.sourceID != sourceID }
        save()
    }
    func dismissUploadFailure(_ id: UUID) {
        for key in hosts[namespace]?.records.keys.map({ $0 }) ?? [] {
            hosts[namespace]?.records[key]?.uploadFailures?.removeAll { $0.id == id }
        }
        save()
    }
    func dismissUploadFailures(for key: String) {
        hosts[namespace]?.records[key]?.uploadFailures = nil
        save()
    }
    @discardableResult func completeUpload(_ file: Attachment, token: DraftUploadToken) -> Bool {
        guard isCurrentUpload(token) else { return false }
        addFile(file, for: token.key)
        return true
    }

    var pendingCount: Int {
        (hosts[namespace]?.records.values.filter {
            !$0.text.isEmpty || !$0.attachments.isEmpty || !($0.uploadFailures ?? []).isEmpty
        }.count ?? 0)
            + memos.values.filter { !$0.isEmpty }.count
    }
    func memo(for decisionID: String) -> String? { hosts[namespace]?.memos[decisionID] }
    func setMemo(_ value: String, for decisionID: String) {
        hosts[namespace, default: Host()].memos[decisionID] = value; save()
    }
    func clearMemo(_ decisionID: String) { hosts[namespace]?.memos.removeValue(forKey: decisionID); save() }
    func removeAll() {
        hosts[namespace] = Host(handoffs: hosts[namespace]?.handoffs)
        connectionGeneration = UUID()
        save()
    }
    private func edit(_ key: String, _ change: (inout Record) -> Void) {
        var record = hosts[namespace]?.records[key] ?? Record()
        record.revision += 1
        change(&record)
        hosts[namespace, default: Host()].records[key] = record
        save()
    }
    private func save() {
        guard canPersist else { return }
        do { try storage.write(hosts); persistenceError = nil }
        catch { persistenceError = error.localizedDescription }
    }
}
