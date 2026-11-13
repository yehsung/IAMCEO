import Foundation
import Observation
import SwiftUI

/// D1: 앱을 새 버전으로 바꿨는데 이 Mac 의 서버는 옛 버전으로 계속 돌 때, 한 번 묻고 앱에 든 새 서버로 다시 시작한다.
/// 앱이 직접 관리하는 설치판 서버만 대상이다(LocalHostService.upgradeOffer). git 체크아웃에서 도는 서버에는 묻지 않는다.
/// 같은 앱 빌드에 대해서는 한 번만 묻는다. '나중에'를 고르면 설정의 '서버 다시 시작' 줄에서 언제든 할 수 있다.
@MainActor @Observable
final class ServerUpgradeWatch {
    static let shared = ServerUpgradeWatch()

    /// 지금 붙은 서버에 대한 제안. 설정의 '서버 다시 시작' 줄이 이것을 보인다.
    private(set) var offer: ServerUpgradeOffer?
    /// 지금 물어야 할 제안과 그 질문을 띄울 창.
    private(set) var prompt: (offer: ServerUpgradeOffer, window: UUID)?
    private(set) var isRestarting = false
    private(set) var error: String?

    typealias Check = @MainActor (String) async -> ServerUpgradeOffer?
    typealias Restart = @MainActor (String, ServerUpgradeOffer) async throws -> Void

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let check: Check
    @ObservationIgnored private let restartAction: Restart
    @ObservationIgnored private var evaluatedKey: String?
    /// 지금 확인 중인 키와 그 확인의 세대. 더 새 확인이나 연결 끊김이 앞서면 늦게 돌아온 결과는 버린다.
    @ObservationIgnored private var inFlightKey: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var endpoint = ""
    private static let askedKey = "IAMCEO.serverUpgrade.askedBuildID"

    init(defaults: UserDefaults = .standard, check: Check? = nil, restart: Restart? = nil) {
        self.defaults = defaults
        #if os(macOS)
        self.check = check ?? { endpoint in await LocalHostService.checkServerUpgrade(endpoint: endpoint) }
        let host = LocalHostService()
        self.restartAction = restart ?? { endpoint, offer in try await host.restartWithBundledServer(endpoint: endpoint, expected: offer) }
        #else
        self.check = check ?? { _ in nil }
        self.restartAction = restart ?? { _, _ in }
        #endif
    }

    /// 연결이 바뀔 때(주소·연결 상태·서버 버전) 한 번 본다. 같은 조합은 다시 보지 않는다.
    /// - window: 질문을 띄울 창. 먼저 부른 창이 맡는다.
    func evaluate(endpoint: String, onThisMac: Bool, connected: Bool, demo: Bool, serverVersion: String?, window: UUID) async {
        // 다시 시작은 서버를 내리므로 연결이 끊긴다. 그동안 제안을 지우면 실패했을 때 까닭과 '다시 시작' 줄이 함께 사라진다.
        guard !isRestarting else { return }
        guard onThisMac, connected, !demo, let serverVersion, !serverVersion.isEmpty else {
            if !connected || !onThisMac { offer = nil; prompt = nil; evaluatedKey = nil; inFlightKey = nil; generation &+= 1 }
            return
        }
        let key = endpoint + "|" + serverVersion
        // 같은 키를 이미 확인했거나 확인하는 중이면(다른 창이 먼저 불렀다) 그 결과를 쓴다.
        guard evaluatedKey != key, inFlightKey != key else { return }
        generation &+= 1
        let mine = generation
        inFlightKey = key
        let found = await check(endpoint)
        // 더 새 확인이나 연결 끊김이 앞섰다. 늦게 돌아온 결과로 '확인했고 제안 없음'을 남기지 않는다.
        guard mine == generation else { return }
        inFlightKey = nil
        // 확인이 중간에 취소됐다(연결이 흔들려 .task 가 바뀜). 결과를 믿지 않고, 다음에 같은 키로 다시 본다.
        guard !Task.isCancelled else { return }
        evaluatedKey = key
        self.endpoint = endpoint
        offer = found
        guard let found else { prompt = nil; return }
        // 같은 앱 빌드에는 한 번만 묻는다.
        guard defaults.string(forKey: Self.askedKey) != found.bundledBuildID else { return }
        defaults.set(found.bundledBuildID, forKey: Self.askedKey)
        prompt = (found, window)
    }

    /// 질문을 닫는다('나중에'). 제안 자체는 설정에 남는다.
    func dismissPrompt() { prompt = nil }

    /// 앱에 든 서버로 다시 시작한다. 끝나면 실시간 연결을 다시 잇는다.
    func restart(store: AppStore?) async {
        guard let offer, !isRestarting else { return }
        prompt = nil; error = nil; isRestarting = true
        do {
            try await restartAction(endpoint, offer)
            self.offer = nil
            evaluatedKey = nil
            isRestarting = false
            await store?.restartRealtime()
        } catch {
            isRestarting = false
            // 실패하면 시작 때 잡은 제안을 다시 둔다. 설정의 줄이 까닭과 '다시 시작'을 함께 보인다.
            self.offer = offer
            self.error = error.localizedDescription
        }
    }
}

/// Mac 주 창에 붙는 버전 고리: 새 버전 확인(D6)을 켜고, 이 Mac 의 서버가 옛 버전이면 한 번 묻는다(D1).
struct VersionWatchHooks: ViewModifier {
    let store: AppStore
    @State private var window = UUID()

    private var watch: ServerUpgradeWatch { ServerUpgradeWatch.shared }
    private var key: String {
        "\(store.serverIsThisMac)|\(store.connectionStatus.rawValue)|\(store.endpoint)|\(store.bootstrap?.version ?? "")"
    }

    func body(content: Content) -> some View {
        content
            .task { UpdateChecker.shared.start() }
            .task(id: key) {
                await watch.evaluate(endpoint: store.endpoint, onThisMac: store.serverIsThisMac, connected: store.connectionStatus == .connected,
                                     demo: store.isDemo, serverVersion: store.bootstrap?.version, window: window)
            }
            .alert("서버를 새 버전으로 다시 시작할까요?", isPresented: Binding(
                get: { watch.prompt?.window == window },
                set: { if !$0 { watch.dismissPrompt() } }
            ), presenting: watch.prompt?.offer) { _ in
                Button("다시 시작") { Task { await watch.restart(store: store) } }
                Button("나중에", role: .cancel) { watch.dismissPrompt() }
            } message: { offer in
                Text(ServerUpgradeText.question(offer))
            }
    }
}

/// D1 의 사용자 문구. 설정 줄과 질문이 같은 말을 쓴다.
enum ServerUpgradeText {
    static func question(_ offer: ServerUpgradeOffer) -> String {
        String(localized: "이 Mac의 서버는 옛 버전(\(offer.runningVersion))으로 돌고 있습니다. 설치한 앱에 든 새 버전(\(offer.bundledVersion))으로 다시 시작합니다. ")
            + String(localized: "몇 초 동안 연결이 끊기지만 팀장 세션은 그대로 이어집니다.")
    }
    static func settingsHint(_ offer: ServerUpgradeOffer) -> String {
        String(localized: "도는 서버 \(offer.runningVersion) · 앱에 든 서버 \(offer.bundledVersion). 팀장 세션은 그대로 이어집니다.")
    }
}
