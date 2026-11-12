import Foundation
import Observation
import SwiftUI

// G(C3): 설정 → 연결의 '연결된 기기'. GET /api/devices 로 읽고 DELETE /api/devices/:id 로 한 대만 끊는다.
// QR 로 연결한 기기는 기기마다 따로 열쇠를 받는다. 공용 접속 코드로 붙은 쪽은 한 줄('공용 접속 코드')로 보이고,
// 그 줄을 끊는 것은 서버 컴퓨터에서 접속 코드를 바꾸는 것이다. 옛 서버는 경로를 모른다(404): 그때 이 묶음은 보이지 않는다.

/// QR 로 연결한 기기 하나. 열쇠 값은 서버가 싣지 않는다.
struct ConnectedDevice: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    /// ios · macos. 이전 앱이면 없다.
    var platform: String?
    var pairedAt: String
    var lastSeenAt: String?
    /// 이 목록을 부른 기기(지금 이 앱)다.
    var current: Bool

    enum CodingKeys: String, CodingKey { case id, name, platform, pairedAt, lastSeenAt, current }

    init(id: String, name: String, platform: String? = nil, pairedAt: String, lastSeenAt: String? = nil, current: Bool = false) {
        self.id = id; self.name = name; self.platform = platform; self.pairedAt = pairedAt; self.lastSeenAt = lastSeenAt; self.current = current
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? "이름 없는 기기"
        platform = c.lenient(String.self, forKey: .platform)
        pairedAt = c.lenient(String.self, forKey: .pairedAt) ?? ""
        lastSeenAt = c.lenient(String.self, forKey: .lastSeenAt)
        current = c.lenient(Bool.self, forKey: .current) ?? false
    }
}

/// 공용 접속 코드로 붙은 접속(플랫폼별 마지막 접속).
struct SharedCodeAccess: Decodable, Sendable, Equatable {
    struct Seen: Decodable, Sendable, Equatable { var platform: String; var lastSeenAt: String }
    var lastSeenAt: String?
    var platforms: [Seen]
    var current: Bool
    var rotatedAt: String?

    enum CodingKeys: String, CodingKey { case lastSeenAt, platforms, current, rotatedAt }

    init(lastSeenAt: String? = nil, platforms: [Seen] = [], current: Bool = false, rotatedAt: String? = nil) {
        self.lastSeenAt = lastSeenAt; self.platforms = platforms; self.current = current; self.rotatedAt = rotatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lastSeenAt = c.lenient(String.self, forKey: .lastSeenAt)
        platforms = c.lenientArray(Seen.self, forKey: .platforms) ?? []
        current = c.lenient(Bool.self, forKey: .current) ?? false
        rotatedAt = c.lenient(String.self, forKey: .rotatedAt)
    }
}

struct AccessFailures: Decodable, Sendable, Equatable {
    var count: Int
    var days: Int
    var lastAt: String?

    enum CodingKeys: String, CodingKey { case count, days, lastAt }
    init(count: Int = 0, days: Int = 7, lastAt: String? = nil) { self.count = count; self.days = days; self.lastAt = lastAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.lenient(Int.self, forKey: .count) ?? 0
        days = c.lenient(Int.self, forKey: .days) ?? 7
        lastAt = c.lenient(String.self, forKey: .lastAt)
    }
}

/// GET /api/devices. 기록(events)은 화면에 쓰지 않아 읽지 않는다.
struct DeviceAccessList: Decodable, Sendable, Equatable {
    var shared: SharedCodeAccess
    var devices: [ConnectedDevice]
    var failures: AccessFailures

    enum CodingKeys: String, CodingKey { case shared, devices, failures }
    init(shared: SharedCodeAccess = SharedCodeAccess(), devices: [ConnectedDevice] = [], failures: AccessFailures = AccessFailures()) {
        self.shared = shared; self.devices = devices; self.failures = failures
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // 기기 목록이 없으면 이 경로의 답이 아니다.
        devices = try c.requiredLossyArray(ConnectedDevice.self, forKey: .devices)
        shared = c.lenient(SharedCodeAccess.self, forKey: .shared) ?? SharedCodeAccess()
        failures = c.lenient(AccessFailures.self, forKey: .failures) ?? AccessFailures()
    }
}

/// 화면 글자. 시험이 같은 함수를 부른다.
enum ConnectedDevicesText {
    static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "ios": "iPhone"
        case "macos": "Mac 앱"
        case "local": "이 Mac"
        default: "기타"
        }
    }

    static func deviceHint(_ device: ConnectedDevice, now: Date = Date()) -> String {
        var parts: [String] = []
        if let platform = device.platform { parts.append(platformLabel(platform)) }
        let seen = relativeTime(device.lastSeenAt, now: now)
        parts.append(seen.isEmpty ? "아직 접속하지 않음" : "마지막 접속 \(seen)")
        let paired = relativeTime(device.pairedAt, now: now)
        if !paired.isEmpty { parts.append("연결 \(paired)") }
        return parts.joined(separator: " · ")
    }

    static func sharedHint(_ shared: SharedCodeAccess, now: Date = Date()) -> String {
        let seen = relativeTime(shared.lastSeenAt, now: now)
        guard !seen.isEmpty else { return "최근 접속 기록이 없습니다" }
        var seenLabels: Set<String> = []
        let labels = shared.platforms.map { platformLabel($0.platform) }.filter { seenLabels.insert($0).inserted }
        return (["마지막 접속 \(seen)"] + (labels.isEmpty ? [] : [labels.joined(separator: ", ")])).joined(separator: " · ")
    }

    static func failureValue(_ failures: AccessFailures) -> String {
        failures.count == 0 ? "없음" : "\(failures.days)일간 \(failures.count)번"
    }

    static func failureHint(_ failures: AccessFailures, now: Date = Date()) -> String {
        let last = relativeTime(failures.lastAt, now: now)
        return last.isEmpty ? "틀린 코드나 끊은 기기로 들어오려 한 횟수" : "틀린 코드나 끊은 기기로 들어오려 한 횟수 · 마지막 \(last)"
    }

    static let footnote = "공용 접속 코드로 붙은 기기를 끊으려면 서버 컴퓨터에서 접속 코드를 바꿉니다(iamceo auth rotate). QR로 연결한 기기는 그대로입니다."

    static func confirmTitle(_ device: ConnectedDevice) -> String { "‘\(device.name)’ 연결을 끊을까요?" }
    static func confirmMessage(_ device: ConnectedDevice) -> String {
        device.current
            ? "지금 쓰는 이 기기입니다. 바로 연결이 끊기고, 다시 쓰려면 Mac에서 새 QR을 만들어 연결해야 합니다."
            : "그 기기는 바로 연결이 끊기고, 다시 쓰려면 Mac에서 새 QR을 만들어 연결해야 합니다. 다른 기기는 그대로입니다."
    }
}

/// 설정 화면이 쥐는 기기 목록 상태. 연결이 바뀌면 앞 서버의 목록을 지운다.
@MainActor @Observable final class DevicesPanel {
    private(set) var list: DeviceAccessList?
    /// 서버가 기기 목록을 모른다(옛 서버). 이때 묶음을 보이지 않는다.
    private(set) var unsupported = false
    private(set) var loading = false
    private(set) var error: String?
    private(set) var revoking: String?
    private(set) var revokeError: String?
    private var token = 0
    private var owner: ObjectIdentifier?

    func attach(_ api: APIClient?) async {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
        await load(api)
    }

    func reset() {
        token &+= 1
        list = nil; unsupported = false; loading = false; error = nil; revoking = nil; revokeError = nil
    }

    /// 다시 읽는 동안에도 마지막 목록은 그대로 둔다.
    func load(_ api: APIClient?) async {
        guard let api else { return }
        token &+= 1
        let mine = token
        loading = true
        defer { if mine == token { loading = false } }
        do {
            let result: DeviceAccessList = try await api.request("/api/devices")
            guard mine == token else { return }
            list = result; unsupported = false; error = nil
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == token else { return }
            list = nil; unsupported = true; error = nil
        } catch is CancellationError {
        } catch {
            guard mine == token, !Task.isCancelled else { return }
            self.error = Self.message(error, fallback: "연결된 기기를 읽지 못했습니다.")
        }
    }

    /// 한 대만 끊는다. 끊은 뒤 목록을 다시 읽는다(이 기기를 끊었으면 다음 요청부터 연결이 끊긴다).
    @discardableResult func revoke(_ device: ConnectedDevice, api: APIClient?) async -> Bool {
        guard let api, revoking == nil else { return false }
        let mine = token
        revoking = device.id; revokeError = nil
        // 끊은 뒤 다시 읽기(load)가 token 을 올리므로 token 이 아니라 이 기기로 푼다. 연결이 바뀌면 reset 이 이미 비웠다.
        defer { if revoking == device.id { revoking = nil } }
        do {
            struct Result: Decodable, Sendable { let ok: Bool? }
            let _: Result = try await api.request("/api/devices/\(APIClient.segment(device.id))", method: "DELETE")
            guard mine == token else { return true }
            list?.devices.removeAll { $0.id == device.id }
            if !device.current { await load(api) }
            return true
        } catch let failure as APIError where failure.code == "device_not_found" {
            // 다른 기기에서 먼저 끊었다. 목록만 맞춘다.
            guard mine == token else { return false }
            list?.devices.removeAll { $0.id == device.id }
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard mine == token, !Task.isCancelled else { return false }
            revokeError = Self.message(error, fallback: "연결을 끊지 못했습니다.")
            return false
        }
    }

    private static func message(_ error: Error, fallback: String) -> String {
        if let failure = error as? APIError, !failure.message.isEmpty { return failure.message }
        if error is URLError { return "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }
        return fallback
    }
}

/// 설정 → 연결의 '연결된 기기' 묶음(Mac·iPhone 같은 모양). 옛 서버면 아무것도 그리지 않는다.
struct ConnectedDevicesGroup: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @State private var panel = DevicesPanel()
    @State private var confirming: ConnectedDevice?

    var body: some View {
        content
            .task(id: reloadKey) { await panel.attach(store.api) }
            .confirmationDialog(confirming.map(ConnectedDevicesText.confirmTitle) ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                                titleVisibility: .visible, presenting: confirming) { device in
                Button("끊기", role: .destructive) { Task { await panel.revoke(device, api: store.api) } }
                Button("취소", role: .cancel) {}
            } message: { device in
                Text(ConnectedDevicesText.confirmMessage(device))
            }
    }

    /// 연결이 바뀌거나 Mac 의 QR 창이 닫히면(새 기기가 붙었을 수 있다) 다시 읽는다.
    private var reloadKey: String {
        "\(store.api.map { "\(ObjectIdentifier($0).hashValue)" } ?? "none")|\(router.showPairing)"
    }

    @ViewBuilder private var content: some View {
        if !panel.unsupported, store.api != nil {
            // 읽기·끊기 실패는 묶음 아래 한 줄(위험 색)로, 평소에는 공용 코드를 끊는 법을 적는다.
            let problem = panel.revokeError ?? panel.error
            SettingsGroup("연결된 기기", footnote: problem ?? (panel.list == nil ? nil : ConnectedDevicesText.footnote),
                          footnoteTone: problem == nil ? CE.ink2 : CE.danger, accessory: {
                SettingsRefreshButton(label: "연결된 기기 다시 확인", busy: panel.loading) { Task { await panel.load(store.api) } }
                    .disabled(store.connectionStatus != .connected)
            }) {
                if let list = panel.list {
                    rows(list)
                } else {
                    SettingsRow("연결된 기기", hint: panel.loading ? "불러오는 중" : "연결한 뒤 볼 수 있습니다") {
                        if panel.loading { ProgressView().controlSize(.small) }
                    }
                }
            }
        }
    }

    @ViewBuilder private func rows(_ list: DeviceAccessList) -> some View {
        SettingsRow("공용 접속 코드", hint: ConnectedDevicesText.sharedHint(list.shared)) {
            if list.shared.current { Tag("이 기기", tone: .accent) }
        }
        ForEach(list.devices) { device in
            RowDivider(inset: 0)
            SettingsRow(device.name, hint: ConnectedDevicesText.deviceHint(device)) {
                HStack(spacing: 8) {
                    if device.current { Tag("이 기기", tone: .accent) }
                    Button { confirming = device } label: {
                        HStack(spacing: 6) {
                            if panel.revoking == device.id { ProgressView().controlSize(.small) }
                            Text(panel.revoking == device.id ? "끊는 중" : "끊기").foregroundStyle(CE.danger)
                        }
                    }
                    .ceSecondaryButton()
                    .ceCompactControl()
                    .fixedSize()
                    .disabled(panel.revoking != nil || store.connectionStatus != .connected)
                    .accessibilityLabel("\(device.name) 연결 끊기")
                }
            }
        }
        RowDivider(inset: 0)
        SettingsRow("최근 실패한 시도", hint: ConnectedDevicesText.failureHint(list.failures)) {
            Text(ConnectedDevicesText.failureValue(list.failures))
                .font(SetupFont.value)
                .foregroundStyle(list.failures.count > 0 ? CE.attention : CE.ink)
        }
    }
}
