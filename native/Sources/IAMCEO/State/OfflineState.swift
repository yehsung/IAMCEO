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
// V(0.2.5): 대기열의 글은 쓴 서버의 것이다(프로젝트·팀장 ID 가 그 서버 것이다). 서버 신원(Bootstrap.server.id)에 묶어,
// 다른 서버에 붙은 동안에는 보내지 않고 따로 보이며(읽기·복사·지우기), 그 서버에 다시 붙으면 보낸다. 말없이 지우지 않는다.
// 쓴 지(고치거나 보내기를 고른 지) 하루가 넘은 글은 저절로 보내지 않고 '확인 필요'로 남긴다. 30일이 지난 글은 지운다.

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
    /// V: 쓸 때 보던 서버의 ID(Bootstrap.server.id). 옛 서버에서 썼거나 이 칸을 남기기 전 판의 글이면 nil 이고,
    /// 그때는 예전처럼 주소와 데이터 폴더로 가린다(AppStore.sameServer). 그 판정으로 지금 서버 것이 되면 지금 서버의 ID 를 단다.
    var serverID: String? = nil
    /// V: '확인 필요'인 글에서 대표가 보내기를 고른 때. 그때부터 다시 하루 동안은 순서대로 저절로 보낸다.
    var confirmedAt: Date? = nil
    /// V(리뷰 safety-1·2): 쓸 때 보던 서버의 표지(데이터 폴더·자기 주소). 글마다 둔다. 주소마다 하나인 표지(OutboxState.owners)는
    /// 같은 주소에 다른 서버가 붙으면 덮이므로, 옛 글의 판정이 뒤집히지 않게 글에 고정한다. 이 칸이 없던 판의 글은 읽을 때
    /// 그 주소의 표지를 복사해 고정한다(OfflineStateStore.load).
    var owner: QueueOwner? = nil

    var draftGeneration: UUID { UUID(uuidString: id) ?? UUID() }
    @MainActor var draftKey: String { DraftStore.key(project: projectID, target: targetMemberID) }

    /// 대표가 마지막으로 이 글을 쓰거나 고치거나 보내기를 고른 때. '확인 필요'(하루)와 지우기(30일)를 이때부터 센다.
    /// 가장 나중의 동작(보내기를 고름 → 고침 → 씀 순서)의 시각이다. 고치면 보내기를 고른 기록은 지워진다(새 글).
    /// 시각 가운데 큰 값을 쓰지 않는 까닭: 기기 시계가 앞서 있을 때 남긴 미래 시각이 뒤의 동작을 가리지 않게(리뷰 safety-4).
    var touchedAt: Date { confirmedAt ?? editedAt ?? createdAt }
    /// 하루가 넘었다: 연결돼도 저절로 보내지 않고 대표가 보내기·고치기·지우기를 고른다.
    /// 리뷰 safety-4: 지금보다 몇 분 넘게 미래인 시각(기기 시계를 앞당겼다가 되돌렸다)은 언제 쓴 글인지 믿을 수 없어 '확인 필요'로 본다.
    func needsReview(now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(touchedAt)
        return age > OfflineStateStore.reviewAge || age < -OfflineStateStore.clockSkewAllowance
    }
    /// 이때 기기에서 지운다.
    var expiresAt: Date { touchedAt.addingTimeInterval(OfflineStateStore.expiryAge) }
    /// 지우기 전 마지막 7일: 목록에 '곧 지워짐'.
    func expiresSoon(now: Date = Date()) -> Bool { expiresAt.timeIntervalSince(now) <= OfflineStateStore.expiryNoticeAge }

    /// 같은 글을 다른 주소 몫으로(ID·만든 때·고친 때·서버 그대로). 같은 서버를 다른 주소로 다시 붙었을 때만 쓴다.
    func moved(to namespace: String) -> QueuedMessage {
        QueuedMessage(id: id, namespace: namespace, projectID: projectID, targetMemberID: targetMemberID, targetName: targetName,
                      text: text, createdAt: createdAt, editedAt: editedAt, serverID: serverID, confirmedAt: confirmedAt, owner: owner)
    }
}

/// V(리뷰 safety-1·3): 두 서버가 같은 서버인지 신원(서버 ID·데이터 폴더)만으로 가린다. 같으면 true, 다르면 false,
/// 가릴 수 없으면(ID 를 하나라도 모름) nil 이고 부르는 쪽이 예전 판정(주소·데이터 폴더)을 쓴다.
/// 데이터 폴더(Bootstrap.home)를 둘 다 알고 서로 다르면 ID 가 같아도 다른 서버다: 같은 곳 복원(`iamceo restore`)으로 다른 폴더에
/// 만든 사본과 DB 를 복사해 띄운 시험 서버는 원본과 서버 ID 가 같다. 진짜 같은 서버를 다르다고 잘못 보면 글이 남을 뿐이고
/// (대기열 화면에서 복사·지우기), 반대로 잘못 보면 시험 지시가 라이브 총괄로 가므로 안전한 쪽으로 틀린다.
enum ServerIdentity {
    static func same(id a: String?, home homeA: String?, as b: String?, home homeB: String?) -> Bool? {
        if let homeA, let homeB, !homeA.isEmpty, !homeB.isEmpty, homeA != homeB { return false }
        guard let a, let b else { return nil }
        return a == b
    }
}

/// 대기열에서 나가 서버로 간 글. 결과가 정해질 때까지 다음 글을 보내지 않는다(순서를 지킨다).
struct SentQueuedMessage: Codable, Sendable, Equatable {
    let attemptID: String
    let namespace: String
    /// V: 그 글을 쓴 서버의 ID. 이 칸이 없던 판의 기록이면 nil.
    var serverID: String? = nil
    /// V(리뷰 safety-1): 그 글을 쓴 서버의 데이터 폴더. 이 칸이 없던 판의 기록이면 nil.
    var home: String? = nil
}

struct OutboxState: Codable, Sendable, Equatable {
    var items: [QueuedMessage] = []
    var sent: [SentQueuedMessage] = []
    /// 서버별로 보내기를 멈춘 까닭(앞선 글이 접수되지 않았을 때). 대표가 '이어서 보내기'를 누르면 지운다.
    /// 열쇠는 `pauseKey`: 서버 ID 를 알면 '주소 + 서버 ID', 모르면(옛 서버, 0.2.4 파일) 주소만(리뷰 safety-5).
    var paused: [String: String] = [:]
    /// 주소마다 그 글을 쓸 때 보던 서버. 0.2.4 파일을 읽을 때 글마다의 표지(QueuedMessage.owner)로 옮기는 데와,
    /// 표지 없이 넣는 새 글의 기본값으로만 쓴다(판정은 글마다의 표지로 한다. 리뷰 safety-2). 이 칸이 없던 파일도 읽힌다.
    var owners: [String: QueueOwner]? = nil

    /// 멈춤 열쇠와 주소·서버 ID 사이. 주소(URL 의 origin)에는 이 글자가 들어갈 수 없다.
    static let pauseSeparator: Character = "\u{1F}"
    static func pauseKey(namespace: String, serverID: String?) -> String {
        guard let serverID, !serverID.isEmpty else { return namespace }
        return namespace + String(pauseSeparator) + serverID
    }
    static func pauseParts(_ key: String) -> (namespace: String, serverID: String?) {
        guard let index = key.firstIndex(of: pauseSeparator) else { return (key, nil) }
        return (String(key[..<index]), String(key[key.index(after: index)...]))
    }
    /// 이 서버(`serverID`)가 따르고 풀 수 있는 이 주소의 멈춤 열쇠: ID 를 알면 그 서버의 것과 ID 없이 남은 것,
    /// 모르면(같은 서버인지 가릴 수 없다) 이 주소의 모든 멈춤.
    func pauseKeys(namespace: String, serverID: String?) -> [String] {
        paused.keys.filter { key in
            let parts = Self.pauseParts(key)
            return parts.namespace == namespace && (serverID == nil || parts.serverID == nil || parts.serverID == serverID)
        }.sorted()
    }
    /// 글이 남지 않은 서버의 멈춤을 푼다(멈출 까닭이 남지 않았다). ID 없는 멈춤은 그 주소에 글이 하나도 없을 때만.
    mutating func prunePauses(namespace: String) {
        for key in paused.keys where Self.pauseParts(key).namespace == namespace {
            let owner = Self.pauseParts(key).serverID
            let covered = items.contains { $0.namespace == namespace && (owner == nil || $0.serverID == nil || $0.serverID == owner) }
            if !covered { paused.removeValue(forKey: key) }
        }
    }
}

/// 글을 쓸 때 보던 서버의 표지: 그 서버의 데이터 폴더(Bootstrap.home)와 서버가 알려 준 자기 주소(Bootstrap.urls).
struct QueueOwner: Codable, Sendable, Hashable {
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
    /// V: 이보다 오래된 글(쓰거나 고치거나 보내기를 고른 지)은 저절로 보내지 않는다(오래된 지시가 지금 상황과 안 맞을 수 있다).
    nonisolated static let reviewAge: TimeInterval = 24 * 60 * 60
    /// V: 이보다 오래된 글은 기기에서 지운다. 다른 서버 몫도 같다.
    nonisolated static let expiryAge: TimeInterval = 30 * 24 * 60 * 60
    /// V: 지우기 전 이 기간 동안 목록에 '곧 지워짐'.
    nonisolated static let expiryNoticeAge: TimeInterval = 7 * 24 * 60 * 60
    /// 리뷰 safety-4: 이보다 더 미래인 시각은 기기 시계가 어긋났던 것으로 본다('확인 필요').
    nonisolated static let clockSkewAllowance: TimeInterval = 5 * 60

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

    /// 잠긴 iPhone 에서 시작해 파일을 못 읽었으면, 앱이 앞으로 나올 때 다시 읽는다. 읽혀 있으면 30일이 지난 글만 지운다(V).
    func reloadIfNeeded() {
        guard enabled else { return }
        if persistenceError != nil { load() } else { purgeExpired() }
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
                if let saved = try? JSONDecoder().decode(OutboxState.self, from: data) { outbox = Self.pinningOwners(saved) }
                else { try? FileManager.default.removeItem(at: url) } // 다른 판의 파일: 읽지 못하면 버린다.
            }
            persistenceError = nil
            // V: 30일이 지난 글은 읽자마자 지운다(앱을 오래 열지 않았어도 기기에 남지 않게).
            purgeExpired()
        } catch {
            persistenceError = error.localizedDescription
        }
    }

    /// 리뷰 safety-2: 글마다의 표지가 없는 글(0.2.4 의 파일)에 그 주소의 표지를 복사해 고정한다. 뒤에 같은 주소에 다른 서버가
    /// 붙어 주소의 표지가 덮여도 이 글의 판정은 바뀌지 않는다. 파일에는 다음 쓰기 때 함께 남는다(그 전에 꺼져도 다시 같은 값이 된다).
    static func pinningOwners(_ state: OutboxState) -> OutboxState {
        guard let owners = state.owners, state.items.contains(where: { $0.owner == nil && owners[$0.namespace] != nil }) else { return state }
        var next = state
        next.items = state.items.map { item in
            guard item.owner == nil, let owner = owners[item.namespace] else { return item }
            var pinned = item; pinned.owner = owner; return pinned
        }
        return next
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
    /// 이 서버(`serverID`)의 멈춤 까닭. ID 를 알면 그 서버의 멈춤과 ID 없이 남은 이 주소의 멈춤을, 모르면 이 주소의 어느 멈춤이든 본다
    /// (리뷰 safety-5: 같은 주소의 다른 서버에서 생긴 멈춤이 이 서버를 막거나, 이 서버의 동작이 그 멈춤을 풀지 않게).
    func pausedReason(namespace: String, serverID: String? = nil) -> String? {
        outbox.pauseKeys(namespace: namespace, serverID: serverID).first.flatMap { outbox.paused[$0] }
    }
    func sent(namespace: String) -> [SentQueuedMessage] { outbox.sent.filter { $0.namespace == namespace } }

    /// 상한을 세는 글 수: 이 주소 몫 가운데 이 서버(`serverID`)의 글. 서버 ID 를 모르는 글은 세어 둔다(넘치지 않게).
    func count(namespace: String, serverID: String?) -> Int {
        outbox.items.filter { $0.namespace == namespace && (serverID == nil || $0.serverID == nil || $0.serverID == serverID) }.count
    }

    /// 기기에 남은 뒤에야 돌려준다(남기지 못하면 던지고, 입력칸의 글은 그대로 둔다).
    /// `owner` 는 그 글을 쓸 때 보던 서버(같은 서버를 다른 주소로 다시 붙으면 이 글을 옮겨 보내려고 남긴다).
    /// `serverID` 는 그 서버의 신원(V). 다른 서버에 붙은 동안 이 글을 보내지 않는 데 쓴다.
    @discardableResult func enqueue(namespace: String, projectID: String, targetMemberID: String?, targetName: String?,
                                    text: String, owner: QueueOwner? = nil, serverID: String? = nil, now: Date = Date()) throws -> QueuedMessage {
        if let persistenceError { throw OutboxError.unavailable(persistenceError) }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw OutboxError.empty }
        guard text.count <= Self.textLimit else { throw OutboxError.tooLong }
        // 상한은 서버마다 센다(다른 서버 몫이 이 서버의 자리를 먹지 않게. 4차 리뷰 data-4).
        guard count(namespace: namespace, serverID: serverID) < Self.itemLimit else { throw OutboxError.full }
        let item = QueuedMessage(id: UUID().uuidString, namespace: namespace, projectID: projectID, targetMemberID: targetMemberID,
                                 targetName: targetName, text: text, createdAt: now, serverID: serverID,
                                 owner: owner ?? outbox.owners?[namespace])
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
                                 createdAt: old.createdAt, editedAt: now, serverID: old.serverID, owner: old.owner)
        try update { $0.items[index] = next }
        return next
    }

    /// V: '확인 필요'인 글에서 대표가 보내기를 골랐다. 그때부터 다시 하루 동안은 순서대로 저절로 보낸다.
    func confirm(id: String, now: Date = Date()) throws {
        guard let index = outbox.items.firstIndex(where: { $0.id == id }) else { throw OutboxError.missing }
        try update { $0.items[index].confirmedAt = now }
    }

    /// V: 30일이 지난 글을 지운다(다른 서버 몫도). 글이 남지 않은 주소의 멈춤도 푼다. 지운 수를 돌려준다.
    /// 기기에 쓰지 못하면 아무것도 바꾸지 않는다(다음에 다시 한다).
    @discardableResult func purgeExpired(now: Date = Date()) -> Int {
        guard persistenceError == nil else { return 0 }
        let expired = Set(outbox.items.filter { $0.expiresAt <= now }.map(\.id))
        guard !expired.isEmpty else { return 0 }
        do {
            try update { state in
                let touched = Set(state.items.filter { expired.contains($0.id) }.map(\.namespace))
                state.items.removeAll { expired.contains($0.id) }
                for namespace in touched { state.prunePauses(namespace: namespace) }
            }
        } catch { return 0 }
        return expired.count
    }

    /// 지운 글이 그 서버의 마지막 글이면 멈춤도 푼다(멈출 까닭이 남지 않았다).
    func remove(id: String) throws {
        guard let item = outbox.items.first(where: { $0.id == id }) else { throw OutboxError.missing }
        try update { state in
            state.items.removeAll { $0.id == id }
            state.prunePauses(namespace: item.namespace)
        }
    }

    /// 보내기 직전: 대기열에서 빼고 결과를 기다리는 목록에 넣는다(한 번의 쓰기).
    func markSent(id: String, attemptID: String) throws {
        guard let item = outbox.items.first(where: { $0.id == id }) else { throw OutboxError.missing }
        try update { state in
            state.items.removeAll { $0.id == id }
            if !state.sent.contains(where: { $0.attemptID == attemptID }) {
                let home = item.owner?.home
                state.sent.append(SentQueuedMessage(attemptID: attemptID, namespace: item.namespace, serverID: item.serverID,
                                                    home: home?.isEmpty == false ? home : nil))
            }
        }
    }

    func settle(attemptID: String) throws {
        guard outbox.sent.contains(where: { $0.attemptID == attemptID }) else { return }
        try update { $0.sent.removeAll { $0.attemptID == attemptID } }
    }

    /// `serverID` 는 멈추는 서버의 ID(모르면 주소 단위로 멈춘다. 리뷰 safety-5).
    func pause(namespace: String, serverID: String? = nil, reason: String) throws {
        let key = OutboxState.pauseKey(namespace: namespace, serverID: serverID)
        guard outbox.paused[key] != reason else { return }
        try update { $0.paused[key] = reason }
    }

    /// '이어서 보내기': 이 서버가 따르는 멈춤만 푼다(같은 주소의 다른 서버의 멈춤은 남긴다).
    func resume(namespace: String, serverID: String? = nil) throws {
        let keys = outbox.pauseKeys(namespace: namespace, serverID: serverID)
        guard !keys.isEmpty else { return }
        try update { state in for key in keys { state.paused.removeValue(forKey: key) } }
    }

    /// 이 기기에서 나갈 때: 그 서버 몫의 글(`ids`)과 그 주소에서 이 서버의 기다리던 결과·멈춤을 지운다. 같은 주소라도 다른 서버
    /// (ID 나 데이터 폴더가 다른)의 기다리던 결과와 멈춤은 남긴다. 다른 서버 몫의 글은 지우지 않는다(V: 그 서버에 다시 붙으면 보낸다.
    /// 30일이 지나면 지워진다).
    func removeForLeaving(ids: Set<String>, namespace: String, serverID: String?, home: String? = nil) throws {
        let ownSent: (SentQueuedMessage) -> Bool = {
            $0.namespace == namespace && ServerIdentity.same(id: $0.serverID, home: $0.home, as: serverID, home: home) != false
        }
        let pauses = outbox.pauseKeys(namespace: namespace, serverID: serverID)
        guard outbox.items.contains(where: { ids.contains($0.id) }) || outbox.sent.contains(where: ownSent) || !pauses.isEmpty else { return }
        try update { state in
            state.items.removeAll { ids.contains($0.id) }
            state.sent.removeAll(where: ownSent)
            for key in pauses { state.paused.removeValue(forKey: key) }
        }
    }

    /// 글·기다리던 결과·멈춤이 남아 있는 주소(namespace)들.
    var namespaces: Set<String> {
        Set(outbox.items.map(\.namespace) + outbox.sent.map(\.namespace) + outbox.paused.keys.map { OutboxState.pauseParts($0).namespace })
    }

    /// V: 지금 붙은 서버의 몫으로 판정한 글(`ids`)을 이 주소(`namespace`) 몫으로 모으고, 서버 ID 가 없던 글에는 그 ID(`serverID`)를 단다.
    /// 다음에 같은 주소에 다른 서버가 붙어도 이 글은 이 서버 것으로 남는다.
    /// - 같은 서버를 다른 주소로 다시 붙었을 때(100.x ↔ *.ts.net ↔ HTTPS. 4차 확인 새 문제 2) 그 주소 몫을 옮긴다. 순서는 그대로다.
    /// - 옛 주소로 이 서버에 보낸 글의 결과를 아직 몰랐으면(그 확인은 옛 주소의 전송 기록이 맡아 새 주소로는 할 수 없다) 옮긴 글을
    ///   `waitingReason` 으로 멈춰 두어 대표가 확인한 뒤 '이어서 보내기'로 보낸다. 옛 주소의 멈춤도 따라온다.
    /// - 옛 주소에 다른 서버의 글이 남으면, 누구 것인지 모르는 옛 주소의 기다리던 결과·멈춤은 그대로 두고 옮긴 글도 멈춰 둔다
    ///   (어느 쪽도 순서를 어기고 보내지 않는다).
    /// `owner` 는 지금 붙은 서버(옮긴 글의 새 표지, 표지가 없던 글의 표지).
    func adopt(_ ids: Set<String>, into namespace: String, serverID: String?, owner: QueueOwner, waitingReason: String) throws {
        let moving = outbox.items.filter { ids.contains($0.id) && $0.namespace != namespace }
        let stamping = outbox.items.contains { ids.contains($0.id) && (($0.serverID == nil && serverID != nil) || $0.owner == nil) }
        guard !moving.isEmpty || stamping else { return }
        let home: String? = owner.home.isEmpty ? nil : owner.home
        try update { state in
            let sources = Set(moving.map(\.namespace))
            state.items = state.items.map { item in
                guard ids.contains(item.id) else { return item }
                var next = item.namespace == namespace ? item : item.moved(to: namespace)
                if next.serverID == nil { next.serverID = serverID }
                // 옮긴 글은 지금 서버의 표지(새 주소들)로, 표지가 없던 글은 이 서버의 것으로 판정된 지금 표지를 고정한다(리뷰 safety-2).
                if next.owner == nil || item.namespace != namespace { next.owner = owner }
                return next
            }
            if !moving.isEmpty { state.owners = (state.owners ?? [:]).merging([namespace: owner]) { _, new in new } }
            let target = OutboxState.pauseKey(namespace: namespace, serverID: serverID)
            for from in sources.sorted() {
                let emptied = !state.items.contains { $0.namespace == from }
                // 신원(서버 ID·데이터 폴더)으로 가릴 수 있으면 그것으로(ID 가 같아도 폴더가 다르면 다른 서버. 리뷰 safety-1).
                // 가릴 수 없으면 옛 주소가 통째로 이 서버 것일 때만 이 서버 것으로 본다(예전 판정).
                let judged = { (sent: SentQueuedMessage) in ServerIdentity.same(id: sent.serverID, home: sent.home, as: serverID, home: home) }
                let mine = state.sent.filter { sent in sent.namespace == from && (judged(sent) ?? emptied) }
                let unclear = state.sent.contains { $0.namespace == from && judged($0) == nil && !emptied }
                state.sent.removeAll { sent in mine.contains(sent) }
                // 옛 주소의 멈춤 가운데 이 서버가 따르는 것을 가져온다. 이 서버만의 멈춤은 옮기고, 주소만 아는 멈춤은 옛 주소가
                // 통째로 비었을 때만 옮긴다(아니면 두 곳에 남는다. 어느 쪽도 순서를 어기지 않는다).
                var carried: String?
                for key in state.pauseKeys(namespace: from, serverID: serverID) {
                    carried = carried ?? state.paused[key]
                    let keyServer = OutboxState.pauseParts(key).serverID
                    if emptied || (keyServer != nil && keyServer == serverID) { state.paused.removeValue(forKey: key) }
                }
                let reason = carried ?? (!mine.isEmpty || unclear ? waitingReason : nil)
                if let reason, state.paused[target] == nil { state.paused[target] = reason }
            }
        }
    }

    private func update(_ change: (inout OutboxState) -> Void) throws {
        if let persistenceError { throw OutboxError.unavailable(persistenceError) }
        var next = outbox
        change(&next)
        // 글·결과·멈춤이 남지 않은 주소의 표지는 지운다.
        if let owners = next.owners {
            let live = Set(next.items.map(\.namespace) + next.sent.map(\.namespace) + next.paused.keys.map { OutboxState.pauseParts($0).namespace })
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
