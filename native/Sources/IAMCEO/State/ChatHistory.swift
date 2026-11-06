import Foundation
import Observation

struct ChatHistoryKey: Hashable, Sendable {
    let namespace: String
    let connectionGeneration: UUID
    let projectID: String
    let scope: MessageScope
    var archived = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.namespace.utf8.elementsEqual(rhs.namespace.utf8) && lhs.projectID.utf8.elementsEqual(rhs.projectID.utf8)
            && lhs.connectionGeneration == rhs.connectionGeneration && lhs.archived == rhs.archived
            && scopeBytes(lhs.scope) == scopeBytes(rhs.scope)
    }
    func hash(into hasher: inout Hasher) {
        hasher.combine(Data(namespace.utf8)); hasher.combine(Data(projectID.utf8))
        hasher.combine(connectionGeneration); hasher.combine(archived); hasher.combine(Self.scopeBytes(scope))
    }
    /// Pass the selected project's roster. Removed member IDs remain valid historical scopes.
    static func normalizedScope(targetMemberID: String?, members: [Member]) -> MessageScope {
        guard let targetMemberID else { return .project }
        let lead = members.first { $0.kind == "root" || $0.kind == "conductor" }
        return lead?.id.utf8.elementsEqual(targetMemberID.utf8) == true ? .project : .member(memberId: targetMemberID)
    }
    static func scopeBytes(_ scope: MessageScope) -> Data {
        switch scope {
        case .project: return Data([0])
        case .member(let id): return Data([1]) + Data(id.utf8)
        case .unknown(let kind): return Data([2]) + Data(kind.utf8)
        }
    }
}

struct ChatHistoryAnchor: Equatable, Sendable {
    let messageID: String
    /// The row's top relative to the viewport, including a partially visible row's negative offset.
    let offset: Double
}

enum ChatHistoryChange: Sendable { case initial, prepend, append, update, restore }
enum ChatHistoryLoad: Equatable, Sendable { case initial, older, latest, bridge }
enum ChatHistoryFailure: Error, Equatable { case invalidPage, storeChanged }

struct ChatHistoryRequest: Equatable, Sendable {
    let generation: UUID
    let id: UUID
    let kind: ChatHistoryLoad
    let cursor: String?
    var limit: Int { kind == .initial || kind == .latest ? 200 : 100 }
}

/// A contiguous server-confirmed interval, local optimistic rows, and unplaced entity updates are separate.
/// Byte keys are deliberate: Swift String equality folds canonically equivalent Unicode, SQLite BINARY does not.
struct ChatHistory: Sendable {
    let key: ChatHistoryKey
    private(set) var generation = UUID()
    private(set) var initialized = false
    private(set) var nextCursor: String?
    private(set) var hasOlder = false
    private(set) var loading: ChatHistoryRequest?
    private(set) var error: String?
    private(set) var storeChanged = false
    private(set) var unreadCount = 0
    private(set) var change: ChatHistoryChange = .initial
    var anchor: ChatHistoryAnchor?
    var pinnedToBottom = true
    private var confirmed: [Data: Message] = [:]
    private var optimistic: [Data: Message] = [:]
    private var overlay: [Data: Message] = [:]
    private var journal: [Message] = []
    private struct Bridge: Sendable {
        var items: [Data: Message]
        var cursor: String?
        let anchors: Set<Data>
        let oldTail: Message?
        let oldIDs: Set<Data>
    }
    private var bridge: Bridge?

    var isBridging: Bool { bridge != nil }
    var items: [Message] {
        var rows = confirmed
        for (id, row) in optimistic where rows[id] == nil { rows[id] = row }
        return rows.values.sorted(by: Self.ordered)
    }
    var confirmedItems: [Message] { confirmed.values.sorted(by: Self.ordered) }
    var optimisticIDs: [String] { optimistic.values.map(\.id) }

    static func ordered(_ lhs: Message, _ rhs: Message) -> Bool {
        if !lhs.at.utf8.elementsEqual(rhs.at.utf8) { return lhs.at.utf8.lexicographicallyPrecedes(rhs.at.utf8) }
        return lhs.id.utf8.lexicographicallyPrecedes(rhs.id.utf8)
    }
    func contains(_ message: Message) -> Bool {
        guard message.projectId.utf8.elementsEqual(key.projectID.utf8) else { return false }
        switch key.scope {
        case .project: return true
        case .member(let id):
            return message.memberId?.utf8.elementsEqual(id.utf8) == true || message.targetMemberId?.utf8.elementsEqual(id.utf8) == true
        case .unknown: return false
        }
    }

    mutating func addOptimistic(_ message: Message) {
        guard contains(message), confirmed[Data(message.id.utf8)] == nil else { return }
        optimistic[Data(message.id.utf8)] = message
    }

    /// WS and POST arrivals share this path; explicit retry transitions (failed → queued) remain valid.
    mutating func receive(_ message: Message) {
        guard contains(message) else { return }
        let id = Data(message.id.utf8)
        let wasOptimistic = optimistic[id] != nil
        if loading != nil { journal.append(message) }
        if confirmed[id] != nil {
            optimistic.removeValue(forKey: id)
            confirmed[id] = message
            change = .update
        } else if bridge != nil {
            overlay[id] = message
            if bridge!.items[id] != nil || bridge!.items.values.max(by: Self.ordered).map({ Self.ordered($0, message) }) == true {
                bridge!.items[id] = message
            }
        } else if loading?.kind == .latest || loading?.kind == .initial {
            overlay[id] = message
        } else if initialized, confirmed.isEmpty || confirmed.values.max(by: Self.ordered).map({ Self.ordered($0, message) }) == true {
            confirmed[id] = message
            optimistic.removeValue(forKey: id)
            change = .append
            if !pinnedToBottom && !wasOptimistic { unreadCount += 1 }
        } else {
            // An unknown historical delivery update is not proof of a contiguous interval.
            overlay[id] = message
        }
    }

    mutating func begin(_ kind: ChatHistoryLoad) -> ChatHistoryRequest? {
        guard loading == nil, !storeChanged else { return nil }
        switch kind {
        case .initial: guard !initialized else { return nil }
        case .older: guard initialized, bridge == nil, hasOlder, nextCursor != nil else { return nil }
        case .latest: guard initialized, bridge == nil else { return nil }
        case .bridge: guard bridge != nil, bridge?.cursor != nil else { return nil }
        }
        let cursor = kind == .older ? nextCursor : kind == .bridge ? bridge?.cursor : nil
        let request = ChatHistoryRequest(generation: generation, id: UUID(), kind: kind, cursor: cursor)
        loading = request; error = nil; journal = []
        return request
    }

    @discardableResult mutating func apply(_ page: MessagePage, request: ChatHistoryRequest) -> Bool {
        guard loading == request, request.generation == generation else { return false }
        guard page.projectId.utf8.elementsEqual(key.projectID.utf8), ChatHistoryKey.scopeBytes(page.scope) == ChatHistoryKey.scopeBytes(key.scope),
              page.items.count <= request.limit, page.items.allSatisfy(contains), (!page.hasOlder && page.nextCursor == nil)
                || (page.hasOlder && !page.items.isEmpty && page.nextCursor?.isEmpty == false && page.nextCursor != request.cursor) else {
            fail(ChatHistoryFailure.invalidPage, request: request)
            return false
        }
        let old = confirmed
        let knownIDs = Set(old.keys).union(optimistic.keys)
        let tail = old.values.max(by: Self.ordered)
        var rows: [Data: Message] = [:]
        for message in page.items {
            let id = Data(message.id.utf8)
            rows[id] = overlay.removeValue(forKey: id) ?? message
        }
        // Arrival order, never a made-up ranking of delivery strings.
        for message in journal where rows[Data(message.id.utf8)] != nil { rows[Data(message.id.utf8)] = message }
        let arrivals = journal
        loading = nil; journal = []; error = nil
        switch request.kind {
        case .initial:
            confirmed = rows
            initialized = true; nextCursor = page.nextCursor; hasOlder = page.hasOlder
            confirmed = mergeBufferedTail(confirmed)
            change = .initial
        case .older:
            confirmed.merge(rows) { _, page in page }
            nextCursor = page.nextCursor; hasOlder = page.hasOlder
            change = .prepend
        case .latest:
            if old.isEmpty {
                confirmed = rows
                nextCursor = page.nextCursor; hasOlder = page.hasOlder
                confirmed = mergeBufferedTail(confirmed)
                countNew(oldIDs: knownIDs, oldTail: tail)
            } else if !page.hasOlder && !Set(old.keys).isSubset(of: Set(rows.keys)) {
                bridge = Bridge(items: rows, cursor: nil, anchors: Set(old.keys), oldTail: tail, oldIDs: knownIDs)
                markStoreChanged()
            } else if !Set(rows.keys).isDisjoint(with: old.keys) {
                confirmed.merge(rows) { _, page in page }
                confirmed = mergeBufferedTail(confirmed)
                countNew(oldIDs: knownIDs, oldTail: tail)
            } else {
                bridge = Bridge(items: rows, cursor: page.nextCursor, anchors: Set(old.keys), oldTail: tail, oldIDs: knownIDs)
                mergeBufferedBridgeTail()
            }
        case .bridge:
            guard var staged = bridge else { return false }
            staged.items.merge(rows) { _, page in page }
            staged.cursor = page.nextCursor
            bridge = staged
            if !page.hasOlder && !staged.anchors.isSubset(of: Set(staged.items.keys)) {
                markStoreChanged()
            } else if !Set(rows.keys).isDisjoint(with: staged.anchors) {
                confirmed.merge(staged.items) { _, page in page }
                confirmed = mergeBufferedTail(confirmed)
                bridge = nil
                countNew(oldIDs: staged.oldIDs, oldTail: staged.oldTail)
            } else if !page.hasOlder { markStoreChanged() }
        }
        // Retain events arriving during GET even when omitted from a stale page.
        // Updates to old visible IDs were already applied; no unread increments for replay.
        for message in arrivals {
            let id = Data(message.id.utf8)
            if confirmed[id] != nil { confirmed[id] = message }
            if bridge?.items[id] != nil { bridge?.items[id] = message }
        }
        for id in confirmed.keys { optimistic.removeValue(forKey: id) }
        return true
    }

    mutating func fail(_ failure: Error, request: ChatHistoryRequest) {
        guard loading == request, generation == request.generation else { return }
        loading = nil; journal = []
        if !(failure is CancellationError), (failure as? URLError)?.code != .cancelled { error = failure.localizedDescription }
    }
    mutating func cancel() {
        generation = UUID(); loading = nil; journal = []
    }
    mutating func jumpToLatest() { anchor = nil; pinnedToBottom = true; unreadCount = 0 }

    /// Explicit recovery only. Drafts/attempts are owned elsewhere and cannot be discarded here.
    mutating func restartFromLatest() {
        let staged = bridge
        cancel()
        confirmed = staged?.items ?? [:]
        bridge = nil; overlay = [:]; storeChanged = false; error = nil; unreadCount = 0; anchor = nil
        initialized = false; hasOlder = false; nextCursor = nil
        change = .restore
    }

    private mutating func markStoreChanged() {
        storeChanged = true; error = "서버의 대화 기록이 변경되었습니다"
    }
    private mutating func countNew(oldIDs: Set<Data>, oldTail: Message?) {
        let count = confirmed.filter { id, row in !oldIDs.contains(id) && (oldTail.map { Self.ordered($0, row) } ?? true) }.count
        if !pinnedToBottom { unreadCount += count }
        change = count > 0 ? .append : .update
    }
    private mutating func mergeBufferedTail(_ source: [Data: Message]) -> [Data: Message] {
        var rows = source
        let oldest = rows.values.min(by: Self.ordered)
        for (id, row) in overlay where rows[id] != nil || oldest.map({ !Self.ordered(row, $0) }) == true || rows.isEmpty {
            rows[id] = row; overlay.removeValue(forKey: id); optimistic.removeValue(forKey: id)
        }
        return rows
    }
    private mutating func mergeBufferedBridgeTail() {
        guard var staged = bridge else { return }
        staged.items = mergeBufferedTail(staged.items)
        bridge = staged
    }
}

/// Connection-scoped cache. The active range is unbounded; only two inactive ranges survive eviction.
@MainActor @Observable
final class ChatHistoryCache {
    private(set) var activeKey: ChatHistoryKey?
    private(set) var histories: [ChatHistoryKey: ChatHistory] = [:]
    private var recency: [ChatHistoryKey] = []

    func activate(_ key: ChatHistoryKey) {
        if let activeKey, activeKey != key { histories[activeKey]?.cancel() }
        activeKey = key
        if histories[key] == nil { histories[key] = ChatHistory(key: key) }
        recency.removeAll { $0 == key }; recency.append(key)
        while recency.count > 3 {
            let victim = recency.removeFirst()
            histories.removeValue(forKey: victim)
        }
    }
    func history(for key: ChatHistoryKey) -> ChatHistory? { histories[key] }
    func receive(_ message: Message, namespace: String, connectionGeneration: UUID) {
        for key in Array(histories.keys) where key.namespace == namespace && key.connectionGeneration == connectionGeneration {
            histories[key]?.receive(message)
        }
    }
    func setReadingPosition(_ anchor: ChatHistoryAnchor?, pinned: Bool, for key: ChatHistoryKey) {
        histories[key]?.anchor = anchor; histories[key]?.pinnedToBottom = pinned
        if pinned { histories[key]?.jumpToLatest() }
    }
    func removeAll() { histories = [:]; recency = []; activeKey = nil }
    func invalidate(projectID: String) {
        for key in Array(histories.keys) where key.projectID == projectID {
            histories.removeValue(forKey: key); recency.removeAll { $0 == key }
            if activeKey == key { activeKey = nil }
        }
    }

    /// Single flight includes the bridge queue. Each user continuation fetches at most three pages.
    func load(_ kind: ChatHistoryLoad, for key: ChatHistoryKey, using service: any MessageHistoryService) async {
        guard !Task.isCancelled, activeKey == key, let request = histories[key]?.begin(kind) else { return }
        await fetch(request, for: key, using: service)
        guard !Task.isCancelled, histories[key]?.generation == request.generation, histories[key]?.error == nil,
              kind == .latest || kind == .bridge else { return }
        for _ in 1..<3 {
            guard !Task.isCancelled, activeKey == key, histories[key]?.generation == request.generation,
                  let request = histories[key]?.begin(.bridge) else { break }
            await fetch(request, for: key, using: service)
            if histories[key]?.error != nil { break }
        }
    }
    private func fetch(_ request: ChatHistoryRequest, for key: ChatHistoryKey, using service: any MessageHistoryService) async {
        do {
            try Task.checkCancellation()
            let page: MessagePage
            if key.archived {
                page = try await service.archivedMessagePage(projectID: key.projectID, scope: key.scope, cursor: request.cursor, limit: request.limit)
            } else {
                page = try await service.messagePage(projectID: key.projectID, scope: key.scope, cursor: request.cursor, limit: request.limit)
            }
            try Task.checkCancellation()
            histories[key]?.apply(page, request: request)
        } catch {
            histories[key]?.fail(error, request: request)
        }
    }
}
