import Foundation
import Observation
import SwiftUI
#if os(macOS)
import AppKit
#endif

// N(C8): 설정 → 연결 → iPhone 연결 묶음의 'HTTPS 주소' 줄. Mac 앱이 이 Mac 의 서버(127.0.0.1)에 붙었을 때만 보인다.
// GET /api/tailnet/https 로 읽고 POST {enabled} 로 켜고 끈다(서버는 이 Mac 에서 온 요청만 받는다). 옛 서버는 경로를 모른다(404):
// 그때 이 줄은 그리지 않는다. 켜면 서버가 연결 QR 주소의 맨 앞에 https 주소를 싣는다. 대표가 고를 때만 켠다.

/// GET·POST /api/tailnet/https 의 답(shared/types.ts TailnetHttpsStatus).
struct TailnetHttpsInfo: Decodable, Sendable, Equatable {
    enum State: String, Sendable { case off, on, pending }
    struct Problem: Decodable, Sendable, Equatable {
        var code: String
        var message: String
        var link: String?
        enum CodingKeys: String, CodingKey { case code, message, link }
        init(code: String, message: String, link: String? = nil) { self.code = code; self.message = message; self.link = link }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            code = c.lenient(String.self, forKey: .code) ?? ""
            message = c.lenient(String.self, forKey: .message) ?? ""
            link = c.lenient(String.self, forKey: .link)
        }
    }
    var state: State
    var url: String?
    var problem: Problem?

    enum CodingKeys: String, CodingKey { case state, url, problem }
    init(state: State, url: String? = nil, problem: Problem? = nil) { self.state = state; self.url = url; self.problem = problem }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // state 가 없으면 이 경로의 답이 아니다. 모르는 값은 꺼진 것으로 본다.
        state = State(rawValue: try c.decode(String.self, forKey: .state)) ?? .off
        url = c.lenient(String.self, forKey: .url)
        problem = c.lenient(Problem.self, forKey: .problem).flatMap { $0.message.isEmpty ? nil : $0 }
    }

    /// 켠 기록이 있다(지금 확인되지 않아도). 이때 단추는 '끄기'다.
    var isEnabled: Bool { state == .on || (state == .pending && url != nil) }
}

/// 화면 글자. 시험이 같은 함수를 부른다.
enum TailnetHttpsText {
    static let title = String(localized: "HTTPS 주소")
    static let offHint = String(localized: "켜면 새로 연결하는 iPhone이 Tailscale의 HTTPS 주소로 붙어, 앱의 연결도 따로 암호화됩니다.")
    static let busyHint = String(localized: "Tailscale 설정을 바꾸는 중입니다")
    static let loadingHint = String(localized: "확인하는 중입니다")

    static func hint(_ info: TailnetHttpsInfo?) -> String {
        guard let info else { return loadingHint }
        if let problem = info.problem { return problem.message }
        switch info.state {
        case .on: return String(localized: "\(info.url ?? "") · 새 QR부터 이 주소를 씁니다. 이미 연결한 iPhone은 새 QR로 다시 연결하면 옮겨 갑니다.")
        case .pending: return busyHint
        case .off: return offHint
        }
    }

    static let enableTitle = String(localized: "HTTPS 주소를 켤까요?")
    static let enableMessage = String(localized: "이 Mac의 Tailscale에서 HTTPS(443)를 열어 IAMCEO 서버로 넘깁니다(tailscale serve). 같은 Tailscale 망의 기기만 닿고 인터넷에는 열리지 않습니다. 처음에는 인증서를 받느라 1분쯤 걸릴 수 있습니다.")
    static let disableTitle = String(localized: "HTTPS 주소를 끌까요?")
    static let disableMessage = String(localized: "HTTPS 주소로 연결한 iPhone은 연결이 끊기고, 다시 쓰려면 새 QR로 연결해야 합니다. 이 서버가 만든 Tailscale 설정만 지웁니다.")
}

/// 설정 화면이 쥐는 상태. 연결이 바뀌면 앞 서버의 상태를 지운다.
@MainActor @Observable final class TailnetHttpsPanel {
    private(set) var info: TailnetHttpsInfo?
    /// 서버가 이 경로를 모른다(옛 서버). 이때 줄을 보이지 않는다.
    private(set) var unsupported = false
    private(set) var loading = false
    private(set) var working = false
    private(set) var error: String?
    private var token = 0
    private var owner: ObjectIdentifier?
    /// 켜기는 인증서를 받느라 오래 걸릴 수 있다(서버 쪽 제한 90초 + serve).
    static let changeTimeout: TimeInterval = 150

    func attach(_ api: APIClient?) async {
        let id = api.map { ObjectIdentifier($0) }
        if id != owner { reset(); owner = id }
        await load(api)
    }

    func reset() {
        token &+= 1
        info = nil; unsupported = false; loading = false; working = false; error = nil
    }

    func load(_ api: APIClient?) async {
        guard let api else { return }
        token &+= 1
        let mine = token
        loading = true
        defer { if mine == token { loading = false } }
        do {
            let result: TailnetHttpsInfo = try await api.request("/api/tailnet/https")
            guard mine == token else { return }
            info = result; unsupported = false; error = nil
        } catch let failure as APIError where [404, 405, 501].contains(failure.status) {
            guard mine == token else { return }
            info = nil; unsupported = true; error = nil
        } catch is CancellationError {
        } catch {
            guard mine == token, !Task.isCancelled else { return }
            self.error = Self.message(error)
        }
    }

    @discardableResult func set(_ enabled: Bool, api: APIClient?) async -> Bool {
        guard let api, !working else { return false }
        struct Body: Encodable, Sendable { let enabled: Bool }
        token &+= 1
        let mine = token
        working = true; error = nil
        defer { if mine == token { working = false } }
        do {
            let result: TailnetHttpsInfo = try await api.send("/api/tailnet/https", body: Body(enabled: enabled), timeout: Self.changeTimeout)
            guard mine == token else { return false }
            info = result
            return result.problem == nil
        } catch is CancellationError {
            return false
        } catch {
            guard mine == token, !Task.isCancelled else { return false }
            self.error = Self.message(error)
            return false
        }
    }

    private static func message(_ error: Error) -> String {
        if let failure = error as? APIError, !failure.message.isEmpty { return failure.localizedDescription }
        if error is URLError { return String(localized: "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") }
        return String(localized: "HTTPS 주소 상태를 확인하지 못했습니다.")
    }
}

#if os(macOS)
/// 'iPhone 연결' 묶음 안의 한 줄(앞에 구분선). 이 Mac 의 서버에 붙지 않았거나 옛 서버면 아무것도 그리지 않는다.
struct TailnetHttpsRow: View {
    @Environment(AppStore.self) private var store
    @State private var panel = TailnetHttpsPanel()
    /// true: 켜기를 묻는 중, false: 끄기를 묻는 중.
    @State private var confirming: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // 줄이 없을 때도 읽기(.task)가 돌도록 자리만 둔다(높이 0).
            Color.clear.frame(height: 0)
            if visible {
                RowDivider(inset: 0)
                row
            }
        }
        .task(id: reloadKey) { await panel.attach(store.serverIsThisMac && !store.isDemo ? store.api : nil) }
        // 다른 창에서 켜고 끄는 중이면(서버가 pending 으로 답한다) 끝날 때까지 몇 초마다 다시 읽는다.
        .task(id: waitingKey) {
            guard waiting else { return }
            for _ in 0..<60 {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await panel.load(store.api)
                if !waiting { return }
            }
        }
        .confirmationDialog(confirming == false ? TailnetHttpsText.disableTitle : TailnetHttpsText.enableTitle,
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { enable in
            Button(enable ? "켜기" : "끄기", role: enable ? nil : .destructive) { Task { await panel.set(enable, api: store.api) } }
            Button("취소", role: .cancel) {}
        } message: { enable in
            Text(enable ? TailnetHttpsText.enableMessage : TailnetHttpsText.disableMessage)
        }
    }

    /// 첫 답이 온 뒤에만 보인다. 옛 서버(404)에서 줄이 잠깐 나타났다 사라지지 않게 한다.
    private var visible: Bool { store.serverIsThisMac && !store.isDemo && store.api != nil && !panel.unsupported && (panel.info != nil || panel.error != nil) }
    private var reloadKey: String { "\(store.api.map { "\(ObjectIdentifier($0).hashValue)" } ?? "none")|\(store.serverIsThisMac)" }
    private var waiting: Bool { panel.info?.state == .pending && panel.info?.problem == nil && !panel.working }
    private var waitingKey: String { "\(waiting)|\(reloadKey)" }

    private var row: some View {
        let info = panel.info
        let problem = panel.error != nil || info?.problem != nil
        return SettingsRow(TailnetHttpsText.title, hint: panel.error ?? (panel.working ? TailnetHttpsText.busyHint : TailnetHttpsText.hint(info)),
                           hintTone: panel.error != nil ? CE.danger : problem ? CE.attention : CE.ink2) {
            HStack(spacing: 8) {
                if info?.state == .on, !panel.working { Tag(String(localized: "켜짐"), tone: .success) }
                if let raw = info?.problem?.link, let link = URL(string: raw), link.scheme == "https" {
                    Button { NSWorkspace.shared.open(link) } label: { Text("Tailscale 관리 화면") }
                        .ceSecondaryButton()
                        .ceCompactControl()
                        .fixedSize()
                }
                Button { confirming = !(info?.isEnabled ?? false) } label: {
                    HStack(spacing: 6) {
                        if panel.working { ProgressView().controlSize(.small) }
                        Text(label(info))
                    }
                }
                .ceSecondaryButton()
                .ceCompactControl()
                .fixedSize()
                .disabled(panel.working || info == nil || waiting || store.connectionStatus != .connected)
            }
        }
    }

    private func label(_ info: TailnetHttpsInfo?) -> String {
        let on = info?.isEnabled ?? false
        if panel.working { return on ? String(localized: "끄는 중") : String(localized: "켜는 중") }
        return on ? String(localized: "끄기") : String(localized: "켜기")
    }
}
#endif
