import Foundation

// 쓰기 결과: 화면이 읽는 쓰기 상태 값. 판정은 AppStore 가 한다.

struct SettingsEdit: Sendable {
    let base: Settings
    var draft: Settings
    let revision: Int
}
enum CardWriteStatus: String, Sendable { case accepted, conflict, unknown, refused, notSent }
enum TodoWriteState: String, Sendable { case sending, checking, confirmed, confirmedCurrent, conflict, notApplied }
enum ProjectChangeStatus: String { case sending, checking, applied, current, refused }
