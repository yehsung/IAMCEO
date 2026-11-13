import Foundation
import Observation

// F1(4차 S): 서버에 닿지 않을 때도 앱이 쓸모 있게 하는 두 가지를 기기 안에 둔다.
// 1) 마지막으로 본 상태: 마지막으로 받은 Bootstrap 과 고른 프로젝트의 ProjectState. 시작할 때 서버가 안 닿으면
//    빈 연결 화면 대신 이것을 '마지막으로 본 상태 · n분 전' 읽기 전용으로 보인다(AppStore+Offline.swift).
// 2) 연결되면 보낼 글: 아직 한 번도 보내지 않은 글만 둔다. 보내기 시작하는 순간 대기열에서 빠지고 전송 기록
//    (SubmissionStore)이 맡는다. 결과를 모르는 글은 다시 보내지 않는다는 원칙은 그 기록이 지킨다.
// 둘 다 기기 밖으로 나가지 않는다(백업 제외). iPhone 은 완전 보호 파일이라 잠긴 동안에는 읽히지도 쓰이지도 않는다.
// Mac 은 이 사용자만 읽는 파일(0600)이다. 마지막 상태는 한 서버 것 하나뿐이고, 다른 서버로 바꾸거나 이 기기에서
// 나가거나 접속 코드가 거절되면 지운다. 대기열은 이 기기에서 나갈 때 그 서버 몫을 지운다.

/// 마지막으로 받은 상태 하나. `savedAt` 은 저장한 때가 아니라 서버가 마지막으로 이 상태를 확인해 준 때다.
struct LastSeenSnapshot: Codable, Sendable {
    static let currentVersion = 1
    var version = LastSeenSnapshot.currentVersion
    /// DraftStore.endpointNamespace(서버 주소의 정규형). 이 값이 다른 서버에는 절대 보이지 않는다.
    let namespace: String
    let savedAt: Date
    /// 알림 연결 ID(알림이 이 서버 것인지 맞춰 볼 때만 쓴다). 옛 서버나 알림 조회 전이면 nil.
    let serverID: String?
    var bootstrap: Bootstrap
    var state: ProjectState?
}

/// 화면이 읽는 '지금 보이는 것은 마지막으로 본 상태' 표지.
struct LastSeenInfo: Equatable, Sendable {
    let namespace: String
    let savedAt: Date
    let serverID: String?
}

/// 연결되면 보낼 글 하나. 고치면 새 ID 로 바뀐다(보내다 끊긴 옛 글과 섞이지 않게).
struct QueuedMessage: Codable, Sendable, Identifiable, Equatable {
    /// UUID. 보낼 때 초안 세대로 쓰여, 보내기 직전에 앱이 꺼졌어도 같은 글을 같은 전송 기록으로 다시 찾는다.
    let id: String
    let namespace: String
    let projectID: String
    let targetMemberID: String?
    /// 받는 사람 이름(그 사이 명부에서 빠져도 무엇을 누구에게 쓰려 했는지 보이게).
    let targetName: String?
    var text: String
    let createdAt: Date
    var editedAt: Date?

    var draftGeneration: UUID { UUID(uuidString: id) ?? UUID() }
    @MainActor var draftKey: String { DraftStore.key(project: projectID, target: targetMemberID) }

    /// 같은 글을 다른 주소 몫으로(ID·만든 때·고친 때 그대로). 같은 서버를 다른 주소로 다시 붙었을 때만 쓴다.
    func moved(to namespace: String) -> QueuedMessage {
        QueuedMessage(id: id, namespace: namespace, projectID: projectID, targetMemberID: targetMemberID, targetName: targetName,
                      text: text, createdAt: createdAt, editedAt: editedAt)
    }
}

/// 대기열에서 나가 서버로 간 글. 결과가 정해질 때까지 다음 글을 보내지 않는다(순서를 지킨다).
struct SentQueuedMessage: Codable, Sendable, Equatable {
    let attemptID: String
    let namespace: String
}

struct OutboxState: Codable, Sendable, Equatable {
    var items: [QueuedMessage] = []
    var sent: [SentQueuedMessage] = []
    /// 서버별로 보내기를 멈춘 까닭(앞선 글이 접수되지 않았을 때). 대표가 '이어서 보내기'를 누르면 지운다.
    var paused: [String: String] = [:]
    /// 주소마다 그 글을 쓸 때 보던 서버(같은 서버를 다른 주소로 다시 붙었는지 가릴 때만 쓴다). 이 칸이 없던 파일도 읽힌다.
    var owners: [String: QueueOwner]? = nil
}

/// 글을 쓸 때 보던 서버의 표지: 그 서버의 데이터 폴더(Bootstrap.home)와 서버가 알려 준 자기 주소(Bootstrap.urls).
struct QueueOwner: Codable, Sendable, Equatable {
    let home: String
    let addresses: [String]

    init(home: String, addresses: [String]) {
        self.home = home
        self.addresses = Array(addresses.prefix(16))
    }
    init(_ bootstrap: Bootstrap) { self.init(home: bootstrap.home, addresses: bootstrap.urls) }
}

enum OutboxError: Error, Equatable, LocalizedError {
    case full, tooLong, empty, missing, unavailable(String)

    var errorDescription: String? {
        switch self {
        case .full: String(localized: "연결되면 보낼 글은 \(OfflineStateStore.itemLimit)개까지 둘 수 있습니다. 앞의 글을 보내거나 지운 뒤 다시 넣어 주세요.")
        case .tooLong: String(localized: "글이 너무 깁니다. 나눠서 넣어 주세요.")
        case .empty: String(localized: "보낼 글을 넣어 주세요.")
        case .missing: String(localized: "이미 보내기 시작했거나 지운 글입니다.")
        case .unavailable(let reason): String(localized: "연결되면 보낼 글을 기기에 남기지 못했습니다: \(reason)")
        }
    }
}

/// 쓰기와 지우기를 한 줄로 세운다. 지운 뒤에 늦게 끝난 저장이 파일을 되살리지 못하게 세대(epoch)를 본다.
final class OfflineFileGate: @unchecked Sendable {
    private let lock = NSLock()
    private var minimumEpoch = 0

    /// `epoch` 가 마지막으로 지운 세대보다 오래되면 쓰지 않는다.
    @discardableResult func write(_ data: Data, to url: URL, epoch: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard epoch >= minimumEpoch else { return false }
        return (try? OfflineStateStore.writeProtected(data, to: url)) != nil
    }

    func remove(_ url: URL, epoch: Int) {
        lock.lock(); defer { lock.unlock() }
        minimumEpoch = max(minimumEpoch, epoch)
        try? FileManager.default.removeItem(at: url)
    }
}

@MainActor @Observable
final class OfflineStateStore {
    /// 마지막 상태 파일의 크기 상한. 넘으면 오래된 글과 자료 본문을 덜어 내고, 그래도 넘으면 남기지 않는다.
    nonisolated static let lastSeenByteLimit = 2 * 1024 * 1024
    /// 덜어 낼 때 남기는 최근 글 수.
    nonisolated static let trimmedMessageCount = 40
    nonisolated static let itemLimit = 50
    nonisolated static let textLimit = 20_000

    private(set) var outbox = OutboxState()
    /// 대기열 파일을 읽거나 쓰지 못한 까닭. 이 값이 있으면 대기열을 바꾸지 않는다(읽지 못한 파일을 빈 목록으로 덮지 않게).
    private(set) var persistenceError: String?
    @ObservationIgnored let enabled: Bool
    @ObservationIgnored private let directory: URL?
    @ObservationIgnored private let gate = OfflineFileGate()
    @ObservationIgnored private var epoch = 0

    /// `directory` 를 주면 그 폴더를 쓴다(시험). 주지 않으면 Application Support/IAMCEO/Offline.
    init(persist: Bool = true, directory: URL? = nil) {
        enabled = persist || directory != nil
        self.directory = enabled ? (directory ?? Self.defaultDirectory()) : nil
        guard enabled else { return }
        load()
    }

    /// 잠긴 iPhone 에서 시작해 파일을 못 읽었으면, 앱이 앞으로 나올 때 다시 읽는다.
    func reloadIfNeeded() {
        guard enabled, persistenceError != nil else { return }
        load()
    }

    private func load() {
        guard let folder = directory, let url = outboxURL else {
            persistenceError = String(localized: "기기에 저장할 폴더를 찾지 못했습니다"); return
        }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            var mutable = folder
            try? mutable.setResourceValues(values)
            if let data = try Self.readIfPresent(url) {
                if let saved = try? JSONDecoder().decode(OutboxState.self, from: data) { outbox = saved }
                else { try? FileManager.default.removeItem(at: url) } // 다른 판의 파일: 읽지 못하면 버린다.
            }
            persistenceError = nil
        } catch {
            persistenceError = error.localizedDescription
        }
    }

    private static func defaultDirectory() -> URL? {
        guard let base = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                      appropriateFor: nil, create: true) else { return nil }
        return base.appendingPathComponent("IAMCEO", isDirectory: true).appendingPathComponent("Offline", isDirectory: true)
    }
    private var lastSeenURL: URL? { directory?.appendingPathComponent("last-seen.json") }
    private var outboxURL: URL? { directory?.appendingPathComponent("outbox.json") }

    /// 완전 보호(iPhone), 이 사용자만(0600), 원자적 교체.
    nonisolated static func writeProtected(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func readIfPresent(_ url: URL?) throws -> Data? {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }

    // MARK: Last seen state

    /// 이 서버(`namespace`)의 마지막 상태. 없거나, 다른 서버 것이거나, 읽을 수 없으면(잠긴 기기, 다른 판) nil.
    func readLastSeen(namespace: String) -> LastSeenSnapshot? {
        guard enabled, let url = lastSeenURL else { return nil }
        // 잠긴 iPhone 에서는 완전 보호 파일을 읽지 못한다. 그때는 지우지 않고 없는 것으로 본다.
        guard let data = try? Self.readIfPresent(url) else { return nil }
        guard let snapshot = try? JSONDecoder().decode(LastSeenSnapshot.self, from: data),
              snapshot.version == LastSeenSnapshot.currentVersion else {
            gate.remove(url, epoch: epoch)
            return nil
        }
        // 마지막 상태는 한 서버 것 하나뿐이다. 다른 서버 것이면 남기지 않는다.
        guard snapshot.namespace == namespace else { gate.remove(url, epoch: epoch); return nil }
        return snapshot
    }

    /// 크기 상한 안에서 저장한다. 인코딩과 쓰기는 주 스레드 밖에서 한다. 그 사이 지웠으면 쓰지 않는다.
    func saveLastSeen(_ snapshot: LastSeenSnapshot) async {
        guard enabled, let url = lastSeenURL else { return }
        let epoch = self.epoch, gate = self.gate
        await Task.detached(priority: .utility) {
            guard let data = Self.encodeWithinLimit(snapshot) else {
                // 상한을 넘는 상태는 남기지 않는다. 더 오래된 상태를 '마지막'으로 보이지도 않는다.
                gate.remove(url, epoch: epoch)
                return
            }
            gate.write(data, to: url, epoch: epoch)
        }.value
    }

    /// 상한을 넘으면 오래된 글을 덜고 자료 본문을 비운다. 그래도 넘으면 nil.
    nonisolated static func encodeWithinLimit(_ snapshot: LastSeenSnapshot, limit: Int = lastSeenByteLimit) -> Data? {
        let encoder = JSONEncoder()
        guard let full = try? encoder.encode(snapshot) else { return nil }
        if full.count <= limit { return full }
        var trimmed = snapshot
        if var state = trimmed.state {
            state.messages = Array(state.messages.suffix(trimmedMessageCount))
            state.files = state.files.map { var file = $0; file.body = ""; return file }
            trimmed.state = state
        }
        guard let smaller = try? encoder.encode(trimmed), smaller.count <= limit else { return nil }
        return smaller
    }

    /// 지금 바로 지운다. 늦게 끝나는 저장도 막는다.
    func clearLastSeen() {
        epoch += 1
        guard let url = lastSeenURL else { return }
        gate.remove(url, epoch: epoch)
    }

    // MARK: Outbox

    func items(namespace: String, projectID: String? = nil) -> [QueuedMessage] {
        outbox.items.filter { $0.namespace == namespace && (projectID == nil || $0.projectID == projectID) }
    }
    func pausedReason(namespace: String) -> String? { outbox.paused[namespace] }
    func sent(namespace: String) -> [SentQueuedMessage] { outbox.sent.filter { $0.namespace == namespace } }

    /// 기기에 남은 뒤에야 돌려준다(남기지 못하면 던지고, 입력칸의 글은 그대로 둔다).
    /// `owner` 는 그 글을 쓸 때 보던 서버(같은 서버를 다른 주소로 다시 붙으면 이 글을 옮겨 보내려고 남긴다).
    @discardableResult func enqueue(namespace: String, projectID: String, targetMemberID: String?, targetName: String?,
                                    text: String, owner: QueueOwner? = nil, now: Date = Date()) throws -> QueuedMessage {
        if let persistenceError { throw OutboxError.unavailable(persistenceError) }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw OutboxError.empty }
        guard text.count <= Self.textLimit else { throw OutboxError.tooLong }
        // 상한은 서버마다 센다(다른 서버 몫이 이 서버의 자리를 먹지 않게. 4차 리뷰 data-4).
        guard items(namespace: namespace).count < Self.itemLimit else { throw OutboxError.full }
        let item = QueuedMessage(id: UUID().uuidString, namespace: namespace, projectID: projectID, targetMemberID: targetMemberID,
                                 targetName: targetName, text: text, createdAt: now)
        try update { state in
            state.items.append(item)
            if let owner { state.owners = (state.owners ?? [:]).merging([namespace: owner]) { _, new in new } }
        }
        return item
    }

    func owner(namespace: String) -> QueueOwner? { outbox.owners?[namespace] }

    /// 고친 글은 같은 자리에서 새 ID 로 바뀐다. 이미 보내기 시작한 글이면 `missing`.
    @discardableResult func replaceText(id: String, with text: String, now: Date = Date()) throws -> QueuedMessage {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw OutboxError.empty }
        guard text.count <= Self.textLimit else { throw OutboxError.tooLong }
        guard let index = outbox.items.firstIndex(where: { $0.id == id }) else { throw OutboxError.missing }
        let old = outbox.items[index]
        let next = QueuedMessage(id: UUID().uuidString, namespace: old.namespace, projectID: old.projectID,
                                 targetMemberID: old.targetMemberID, targetName: old.targetName, text: text,
                                 createdAt: old.createdAt, editedAt: now)
        try update { $0.items[index] = next }
        return next
    }

    /// 지운 글이 그 서버의 마지막 글이면 멈춤도 푼다(멈출 까닭이 남지 않았다).
    func remove(id: String) throws {
        guard let item = outbox.items.first(where: { $0.id == id }) else { throw OutboxError.missing }
        try update { state in
            state.items.removeAll { $0.id == id }
            if !state.items.contains(where: { $0.namespace == item.namespace }) { state.paused.removeValue(forKey: item.namespace) }
        }
    }

    /// 보내기 직전: 대기열에서 빼고 결과를 기다리는 목록에 넣는다(한 번의 쓰기).
    func markSent(id: String, attemptID: String) throws {
        guard let item = outbox.items.first(where: { $0.id == id }) else { throw OutboxError.missing }
        try update { state in
            state.items.removeAll { $0.id == id }
            if !state.sent.contains(where: { $0.attemptID == attemptID }) {
                state.sent.append(SentQueuedMessage(attemptID: attemptID, namespace: item.namespace))
            }
        }
    }

    func settle(attemptID: String) throws {
        guard outbox.sent.contains(where: { $0.attemptID == attemptID }) else { return }
        try update { $0.sent.removeAll { $0.attemptID == attemptID } }
    }

    func pause(namespace: String, reason: String) throws {
        guard outbox.paused[namespace] != reason else { return }
        try update { $0.paused[namespace] = reason }
    }

    func resume(namespace: String) throws {
        guard outbox.paused[namespace] != nil else { return }
        try update { $0.paused.removeValue(forKey: namespace) }
    }

    /// 이 기기에서 나갈 때: 그 서버 몫의 대기열과 기다리던 결과를 지운다.
    func removeAll(namespace: String) throws {
        guard outbox.items.contains(where: { $0.namespace == namespace }) || outbox.sent.contains(where: { $0.namespace == namespace })
                || outbox.paused[namespace] != nil else { return }
        try update { state in
            state.items.removeAll { $0.namespace == namespace }
            state.sent.removeAll { $0.namespace == namespace }
            state.paused.removeValue(forKey: namespace)
        }
    }

    /// 글·기다리던 결과·멈춤이 남아 있는 주소(namespace)들.
    var namespaces: Set<String> {
        Set(outbox.items.map(\.namespace) + outbox.sent.map(\.namespace) + outbox.paused.keys)
    }

    /// 같은 서버를 다른 주소로 다시 붙었을 때(100.x ↔ *.ts.net ↔ HTTPS. 4차 확인 새 문제 2): `from` 주소 몫의 아직 보내지 않은
    /// 글을 `to` 주소 몫으로 옮긴다. 순서는 그대로다. 옛 주소로 보낸 글의 결과를 아직 몰랐으면(그 확인은 옛 주소의 전송 기록이
    /// 맡아 새 주소로는 할 수 없다) 옮긴 글을 `waitingReason` 으로 멈춰 두어 대표가 확인한 뒤 '이어서 보내기'로 보낸다.
    /// 옛 주소의 멈춤도 따라온다. 옛 주소의 기다리던 결과는 지운다.
    /// `owner` 는 지금 붙은 서버(옮긴 글의 새 표지).
    func moveQueue(from: String, to: String, owner: QueueOwner, waitingReason: String) throws {
        guard from != to, namespaces.contains(from) else { return }
        try update { state in
            if state.items.contains(where: { $0.namespace == from }) { state.owners = (state.owners ?? [:]).merging([to: owner]) { _, new in new } }
            let moving = state.items.contains { $0.namespace == from }
            let waited = state.sent.contains { $0.namespace == from }
            state.items = state.items.map { $0.namespace == from ? $0.moved(to: to) : $0 }
            state.sent.removeAll { $0.namespace == from }
            let reason = state.paused.removeValue(forKey: from) ?? (waited ? waitingReason : nil)
            if moving, let reason, state.paused[to] == nil { state.paused[to] = reason }
        }
    }

    /// 다른 서버에 연결했을 때: 그 서버 몫만 남기고 이전 서버들에 보내려던 글·기다리던 결과·멈춤을 지운다(4차 리뷰 data-4).
    /// 다른 서버에 붙은 동안에는 옛 몫을 보거나 지울 화면이 없고, 옛 서버에 다시 붙으면 묻지 않고 나가기 때문이다.
    /// 같은 서버의 다른 주소 몫은 먼저 `moveQueue` 로 옮겨 둔다(AppStore.carryOutboxFromOtherAddresses).
    func removeAll(except namespace: String) throws {
        guard outbox.items.contains(where: { $0.namespace != namespace }) || outbox.sent.contains(where: { $0.namespace != namespace })
                || outbox.paused.keys.contains(where: { $0 != namespace }) else { return }
        try update { state in
            state.items.removeAll { $0.namespace != namespace }
            state.sent.removeAll { $0.namespace != namespace }
            state.paused = state.paused.filter { $0.key == namespace }
        }
    }

    private func update(_ change: (inout OutboxState) -> Void) throws {
        if let persistenceError { throw OutboxError.unavailable(persistenceError) }
        var next = outbox
        change(&next)
        // 글·결과·멈춤이 남지 않은 주소의 표지는 지운다.
        if let owners = next.owners {
            let live = Set(next.items.map(\.namespace) + next.sent.map(\.namespace) + next.paused.keys)
            let kept = owners.filter { live.contains($0.key) }
            next.owners = kept.isEmpty ? nil : kept
        }
        if enabled {
            guard let url = outboxURL else { throw OutboxError.unavailable(String(localized: "기기에 저장할 폴더를 찾지 못했습니다")) }
            do {
                if next.items.isEmpty && next.sent.isEmpty && next.paused.isEmpty {
                    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                } else {
                    try Self.writeProtected(try JSONEncoder().encode(next), to: url)
                }
            } catch {
                // 기기에 남기지 못한 변경은 화면에도 반영하지 않는다(대기열에 넣었다고 말하지 않는다).
                throw OutboxError.unavailable(error.localizedDescription)
            }
        }
        outbox = next
    }
}
