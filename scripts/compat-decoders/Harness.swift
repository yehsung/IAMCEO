// D5 호환 게이트의 해석 쪽. scripts/compat-decoders/run.ts 가 출시 태그의 앱 모델 파일(git show)과 이 파일을
// 한 실행 파일로 묶어 빌드한다. 지금 서버가 낸 실제 응답(tests/compat-dump.test.ts 의 덤프)을 그 옛 모델로 풀고,
// 출시 앱이 해석 뒤에 따로 거는 조건도 본다. 하나라도 어긋나면 종료 코드 1.
//
// 실패로 치는 것
// - 해석 실패: 옛 앱이 그 응답 전체를 버린다(동기화가 멈추거나 '연결 중'에 머문다).
// - 알 수 없는 값으로 바뀐 열거값: 옛 앱의 SafeStringEnum 이 모르는 값을 unknown 으로 읽는다(화면이 조용히 비거나 기능이 꺼진다).
// - 건너뛴 부가 정보: 0.2.3 부터의 lenient 해석이 형이 어긋난 칸을 '없음'으로 읽고 넘어간다.
// - 출시 앱의 조건: contractVersion 2, 전달 안내 version 2, hello 의 고정 간격 등. 어긋나면 기능이 조용히 꺼진다.
// 의도한 변경이면 allow.json 에 이유와 함께 적는다.
import Foundation

/// run.ts 가 옛 소스의 두 곳에 이 호출을 끼워 넣는다(값은 그대로 두고 기록만 한다).
enum CompatProbe {
    nonisolated(unsafe) static var records: [String] = []
    static func fallback<T: SafeStringEnum>(_ type: T.Type, _ decoder: Decoder) -> T {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? "?"
        records.append("알 수 없는 값: \(T.self) '\(raw)' 위치 \(path(decoder.codingPath))")
        return T.unknown
    }
    static func skipped(_ type: Any.Type, _ error: any Error, _ fallback: [any CodingKey]) {
        records.append("건너뛴 칸: \(type) \(describe(error, fallback: fallback))")
    }
    static func path(_ keys: [any CodingKey]) -> String {
        keys.isEmpty ? "(맨 위)" : keys.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }
    static func describe(_ error: any Error, fallback: [any CodingKey] = []) -> String {
        guard let decoding = error as? DecodingError else { return "\(error) 위치 \(path(fallback))" }
        switch decoding {
        case .typeMismatch(let type, let context): return "형이 다름(\(type)) 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        case .valueNotFound(let type, let context): return "값이 없음(\(type)) 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        case .keyNotFound(let key, let context): return "필수 칸 없음 '\(key.stringValue)' 위치 \(path(context.codingPath))"
        case .dataCorrupted(let context): return "값이 어긋남 위치 \(path(context.codingPath)) — \(context.debugDescription)"
        @unknown default: return "\(decoding)"
        }
    }
}

struct Entry { let file: String; let type: String; let checks: [String]; let note: String }
struct Allow { let release: String?; let file: String?; let contains: String; let reason: String }

func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> Any { try JSONDecoder().decode(T.self, from: data) }

/// 출시 앱이 받는 형. 이름은 tests/compat-dump.test.ts 의 CompatType 과 같다.
let decoders: [String: (Data) throws -> Any] = [
    "ServerCapabilities": { try decode(ServerCapabilities.self, $0) },
    "Bootstrap": { try decode(Bootstrap.self, $0) },
    "SyncSnapshot": { try decode(SyncSnapshot.self, $0) },
    "ProjectState": { try decode(ProjectState.self, $0) },
    "[Project]": { try decode([Project].self, $0) },
    "MessagePage": { try decode(MessagePage.self, $0) },
    "Message": { try decode(Message.self, $0) },
    "[Message]": { try decode([Message].self, $0) },
    "Decision": { try decode(Decision.self, $0) },
    "[Activity]": { try decode([Activity].self, $0) },
    "DeliveryNoticePage": { try decode(DeliveryNoticePage.self, $0) },
    "DeliveryNotices": { try decode(DeliveryNotices.self, $0) },
    "ModelCatalog": { try decode(ModelCatalog.self, $0) },
    "PushStatus": { try decode(PushStatus.self, $0) },
    "PushDeviceList": { try decode(PushDeviceList.self, $0) },
    "[FileSearchResult]": { try decode([FileSearchResult].self, $0) },
    "SettingsWriteResult": { try decode(SettingsWriteResult.self, $0) },
    "RealtimeEvent": { try decode(RealtimeEvent.self, $0) },
]

/// 해석은 되지만 출시 앱이 따로 거는 조건. 어긋나면 그 기능이 조용히 꺼진다(AppStore 의 같은 판정을 옮겨 왔다).
func check(_ name: String, _ value: Any) -> String? {
    switch name {
    case "contract-v2":
        // AppStore: contractVersion == 2 && operations/realtime == true 가 아니면 v1 쓰기와 3초 조회로 내려간다.
        guard let caps = value as? ServerCapabilities else { return "형이 맞지 않음" }
        guard caps.contractVersion == 2, caps.capabilities?.realtime == true, caps.capabilities?.operations == true else {
            return "contractVersion 2·realtime·operations 가 아니다(옛 앱이 v1 쓰기와 3초 조회로 내려간다)"
        }
    case "sync-ok":
        guard let snapshot = value as? SyncSnapshot else { return "형이 맞지 않음" }
        guard snapshot.projectStatus == .ok, snapshot.state != nil else { return "프로젝트 상태가 ok 가 아니다" }
    case "notices-v2":
        // AppStore.deliveryNotices: version == 2 가 아니면 전달 안내가 조용히 사라진다.
        let version: Int?
        if let snapshot = value as? SyncSnapshot { version = snapshot.state?.deliveryNotices?.version }
        else if let state = value as? ProjectState { version = state.deliveryNotices?.version }
        else if let notices = value as? DeliveryNotices { version = notices.version }
        else { return "형이 맞지 않음" }
        guard version == 2 else { return "전달 안내 version 이 2 가 아니다(\(version.map(String.init) ?? "없음")): 옛 앱에서 전달 안내가 사라진다" }
    case "hello-v2":
        guard let event = value as? RealtimeEvent else { return "형이 맞지 않음" }
        guard event.type == "hello", event.protocolVersion == 2, event.cursor != nil else { return "v2 hello 가 아니다" }
    case "event-payload":
        guard let event = value as? RealtimeEvent else { return "형이 맞지 않음" }
        let present: Bool
        switch event.type {
        case "projects": present = event.projects != nil
        case "project": present = event.project != nil
        case "member": present = event.member != nil
        case "member_removed": present = event.projectId != nil && event.memberId != nil
        case "decision": present = event.decision != nil
        case "todo": present = event.todo != nil
        case "work": present = event.work != nil && event.projectId != nil
        case "message": present = event.message != nil
        case "file": present = event.file != nil
        case "activity": present = event.activity != nil && event.projectId != nil
        case "settings": present = event.settings != nil
        default: return "옛 앱이 모르는 사건 종류 '\(event.type)'"
        }
        guard present, event.cursor != nil else { return "사건 '\(event.type)' 의 본문이나 순번을 읽지 못했다" }
    default:
        return "알 수 없는 검사 '\(name)'"
    }
    return nil
}

@MainActor func run() -> Int32 {
    let arguments = CommandLine.arguments
    guard arguments.count == 4 else {
        print("쓰는 법: CompatCheck <덤프 폴더> <allow.json> <릴리스 이름>")
        return 2
    }
    let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
    let release = arguments[3]
    guard let manifestData = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          let rawEntries = manifest["entries"] as? [[String: Any]], !rawEntries.isEmpty else {
        print("[\(release)] 덤프 목록(manifest.json)을 읽지 못했습니다: \(folder.path)")
        return 2
    }
    let entries = rawEntries.compactMap { raw -> Entry? in
        guard let file = raw["file"] as? String, let type = raw["type"] as? String else { return nil }
        return Entry(file: file, type: type, checks: raw["checks"] as? [String] ?? [], note: raw["note"] as? String ?? "")
    }
    var allows: [Allow] = []
    if let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[2])),
       let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
        allows = list.compactMap { raw in
            guard let contains = raw["contains"] as? String, !contains.isEmpty, let reason = raw["reason"] as? String, !reason.isEmpty else { return nil }
            return Allow(release: raw["release"] as? String, file: raw["file"] as? String, contains: contains, reason: reason)
        }
    }
    var failures = 0, allowed = 0
    for entry in entries {
        guard let decoder = decoders[entry.type] else {
            print("실패 [\(release)] \(entry.file): 이 해석기가 모르는 형 \(entry.type)")
            failures += 1; continue
        }
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(entry.file)) else {
            print("실패 [\(release)] \(entry.file): 덤프 파일이 없습니다")
            failures += 1; continue
        }
        CompatProbe.records.removeAll()
        let value: Any
        do { value = try decoder(data) }
        catch {
            print("실패 [\(release)] \(entry.file) (\(entry.note)): \(entry.type) 해석 실패 — \(CompatProbe.describe(error))")
            failures += 1; continue
        }
        var problems = entry.checks.compactMap { check($0, value) }
        for record in CompatProbe.records {
            if let allow = allows.first(where: { ($0.release ?? release) == release && ($0.file ?? entry.file) == entry.file && record.contains($0.contains) }) {
                allowed += 1
                print("허용 [\(release)] \(entry.file): \(record) — \(allow.reason)")
            } else { problems.append(record) }
        }
        if problems.isEmpty { continue }
        failures += 1
        for problem in problems { print("실패 [\(release)] \(entry.file) (\(entry.note)): \(problem)") }
    }
    print("[\(release)] 응답 \(entries.count)개 가운데 실패 \(failures)개" + (allowed > 0 ? ", 허용 \(allowed)건" : ""))
    return failures == 0 ? 0 : 1
}

exit(run())
