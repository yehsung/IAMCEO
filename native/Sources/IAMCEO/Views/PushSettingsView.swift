import SwiftUI
#if os(iOS)
import UIKit
#endif

/// What the "이 iPhone에서 알림 받기" switch shows. It is on whenever the owner turned it on (even while the iPhone or
/// the server keeps notifications from arriving; the line under it says why) and whenever the server is sending to this
/// iPhone, so switching it off always reaches `disable()`. It is off when another device turned this iPhone off.
enum PhonePushSwitch {
    static func isOn(_ state: PushRegistrationState, device: PushDevice?) -> Bool {
        let serverSends = device?.state == .active && device?.enabled == true
        switch state {
        case .requestingPermission, .registering, .awaitingHost, .denied, .failed:
            return true
        case .enabled:
            return device == nil || serverSends
        case .disabled, .needsHost, .requiresOptIn, .revocationPending, .unsupported:
            return serverSends
        }
    }
}

/// iPhone notifications, in settings › 알림. The server says in one line whether it can send to iPhones (and, when it
/// cannot, the one thing to do on the server computer) and lists the registered iPhones with their choices; an iPhone
/// turns notifications on for itself and picks what it hears about. Push key states stay folded under "자세히".
struct PushSettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var refreshError: String?
    @State private var busy = false
    /// The refresh icon spins only for a refresh the owner asked for, not for the quiet 10-second poll.
    @State private var manualRefresh = false
    @State private var showDetails = PushSettingsView.sampleShowsDetails
    #if os(iOS)
    /// The switch follows the owner's tap until the service finishes (turning off has no in-between state).
    @State private var pendingChoice: Bool?
    /// What the owner last asked for here: tells "turning off failed" from "registering failed".
    @State private var lastChoice: Bool?
    #endif

    /// What is sent, in one line.
    static let coverage = String(localized: "새 결재, 승인·선택 대기, 오류 멈춤, 완료·막힘 보고, 대표 할 일을 알립니다.")
    /// Where the push key goes on the server computer (docs/operating-model.md › APNs 호스트 설정).
    private static let keyFile = "~/.iamceo/apns.json"

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            #if os(iOS)
            if let phone { phoneGroup(phone) }
            #endif
            hostGroup
        }
        .task(id: "\(scenePhase == .active):\(store.pushSettings.generation)") {
            guard scenePhase == .active, !store.isDemo else { return }
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                guard !Task.isCancelled, scenePhase == .active else { return }
                await refresh()
            }
        }
    }

    private var connected: Bool { !store.isDemo && scenePhase == .active && store.connectionStatus == .connected && !store.isRevalidating }

    // MARK: Data (the sample hook can stand in for the server in screenshots)

    private var status: PushStatus? {
        #if DEBUG
        if let sample = Self.sample { return sample.status }
        #endif
        return store.pushSettings.status
    }

    private var devices: [PushDevice] {
        #if DEBUG
        if let sample = Self.sample { return sample.devices }
        #endif
        return store.pushSettings.devices
    }

    /// The iPhones listed under the server line. An iPhone shows its own choices under its own switch instead.
    private var listedDevices: [PushDevice] {
        #if os(iOS)
        guard let mine = phone?.installationID else { return devices }
        return devices.filter { $0.id != mine }
        #else
        return devices
        #endif
    }

    #if os(iOS)
    /// What the "이 iPhone" switch shows and does: the registration service, or (sample hook) a stand-in that does nothing.
    private struct PhoneControl {
        let state: PushRegistrationState
        let systemSettings: PushSystemSettings?
        let installationID: String
        let enable: () async -> Void
        let disable: () async -> Void
        let recheck: () async -> Void
    }

    private var phone: PhoneControl? {
        if let service = store.pushNotifications {
            return PhoneControl(state: service.state, systemSettings: service.systemSettings, installationID: service.installationID,
                                enable: { await service.enable() }, disable: { await service.disable() },
                                recheck: { await service.foreground() })
        }
        #if DEBUG
        if let sample = Self.sample {
            return PhoneControl(state: Self.samplePhoneState ?? (sample.devices.isEmpty ? .disabled : .enabled),
                                systemSettings: PushSystemSettings(authorization: .authorized, alertsEnabled: true, soundsEnabled: false),
                                installationID: "sample-iphone", enable: {}, disable: {}, recheck: {})
        }
        #endif
        return nil
    }
    #endif

    #if DEBUG
    /// Review hook for the read-only sample workspace: `--push-sample ready|ready-off|ready-none|unconfigured` fills this
    /// panel with a sample server state (`ready`: two registered iPhones, one of them off; `ready-off`: this iPhone turned
    /// off from another device; `ready-none`: no iPhone yet). `--push-phone <state>` sets the iPhone's own registration
    /// state. Screenshots only; nothing is sent.
    private static let sample: (status: PushStatus, devices: [PushDevice])? = {
        guard LaunchOptions.demo, let kind = LaunchOptions.value(after: "--push-sample") else { return nil }
        let ready = kind.hasPrefix("ready")
        let status = PushStatus(serverId: "sample", supported: true, providers: [
            PushProviderStatus(environment: .sandbox, bundleId: PushContract.bundleID, state: .unconfigured, lastError: nil),
            PushProviderStatus(environment: .production, bundleId: PushContract.bundleID, state: ready ? .ready : .unconfigured, lastError: nil)
        ])
        let stamp = { (seconds: TimeInterval) in ISO8601DateFormatter().string(from: Date().addingTimeInterval(-seconds)) }
        let phone = PushDevice(id: "sample-iphone", label: "iPhone 16 Pro", platform: "ios", bundleId: PushContract.bundleID,
                               environment: .production, enabled: kind != "ready-off", authorization: .authorized,
                               preferences: PushPreferences(decision: true, approvalWait: true, error: true, reportComplete: false),
                               state: .active, revision: 1, lastSeenAt: stamp(180), lastAcceptedAt: stamp(1500))
        let spare = PushDevice(id: "sample-iphone-2", label: "iPhone 13 mini", platform: "ios", bundleId: PushContract.bundleID,
                               environment: .production, enabled: false, authorization: .authorized,
                               preferences: PushPreferences(decision: true, approvalWait: true, error: true, reportComplete: true),
                               state: .active, revision: 1, lastSeenAt: stamp(86_400 * 3), lastAcceptedAt: stamp(86_400 * 4))
        return (status, kind == "ready-none" || !ready ? [] : [phone, spare])
    }()

    private static var samplePhoneState: PushRegistrationState? {
        switch LaunchOptions.value(after: "--push-phone") {
        case "disabled": .disabled
        case "denied": .denied
        case "failed": .failed
        case "enabled": .enabled
        case "requiresOptIn": .requiresOptIn
        case "revocationPending": .revocationPending
        case "awaitingHost": .awaitingHost
        default: nil
        }
    }
    #endif

    /// `--push-sample unconfigured --push-details` opens "자세히" for its screenshot.
    private static var sampleShowsDetails: Bool {
        #if DEBUG
        return LaunchOptions.demo && LaunchOptions.arguments.contains("--push-details")
        #else
        return false
        #endif
    }

    // MARK: Server line

    /// The one thing to do on the server computer, around the key file's path.
    private struct KeyStep {
        let lead: String
        let tail: String
    }

    private struct HostStatus {
        let tone: Tone
        let text: String
        /// Something is wrong with the push keys: the 개발/배포 rows are one "자세히" away.
        var hasDetails = false
        var step: KeyStep? = nil
        /// The server can send to iPhones (the place to say how to add one).
        var ready = false
    }

    private var hostStatus: HostStatus {
        if store.isDemo && status == nil { return HostStatus(tone: .neutral, text: String(localized: "샘플에서는 쓸 수 없습니다")) }
        if store.pushConnectionError == .unsupported { return HostStatus(tone: .attention, text: String(localized: "이 서버는 iPhone 알림을 지원하지 않습니다")) }
        if let refreshError { return HostStatus(tone: .attention, text: refreshError) }
        guard let status else {
            return HostStatus(tone: .neutral, text: connected ? String(localized: "확인하는 중") : String(localized: "서버에 연결되면 확인합니다"))
        }
        let providers = status.providers
        let ready = Set(providers.filter { $0.state == .ready }.map(\.environment))
        if ready.isEmpty {
            if providers.contains(where: { $0.state == .configurationError }) {
                return HostStatus(tone: .attention, text: isMac ? String(localized: "푸시 키 설정에 오류가 있어 iPhone으로 보낼 수 없습니다") : String(localized: "푸시 키 설정에 오류가 있습니다"), hasDetails: true,
                                  step: KeyStep(lead: String(localized: "서버 컴퓨터의 "), tail: String(localized: "에 적은 키 경로와 파일 권한을 확인하고 서버를 다시 시작합니다.")))
            }
            if providers.contains(where: { $0.state == .temporarilyUnavailable }) {
                return HostStatus(tone: .attention, text: String(localized: "알림 서버를 잠시 쓸 수 없습니다"), hasDetails: true)
            }
            if providers.contains(where: { $0.state == .unknown }) {
                return HostStatus(tone: .attention, text: String(localized: "알림을 보낼 수 있는지 확인하지 못했습니다"), hasDetails: true)
            }
            return HostStatus(tone: .attention, text: isMac ? String(localized: "푸시 키가 설정되지 않아 iPhone으로 보낼 수 없습니다") : String(localized: "푸시 키가 설정되지 않았습니다"), hasDetails: !providers.isEmpty,
                              step: KeyStep(lead: String(localized: "서버 컴퓨터의 "), tail: String(localized: "에 푸시 키(.p8) 경로를 적고 서버를 다시 시작합니다.")))
        }
        let sending = devices.filter { $0.state == .active && $0.enabled == true }
        let missing = Set(sending.compactMap(\.environment).filter { $0 != .unknown && !ready.contains($0) })
        let blocked = sending.filter { device in device.environment.map { missing.contains($0) } ?? false }.count
        if blocked > 0 {
            let kinds = missing.sorted { $0.rawValue < $1.rawValue }.map(environmentName).joined(separator: "·")
            return HostStatus(tone: .attention, text: String(localized: "iPhone \(blocked)대로는 보낼 수 없습니다"), hasDetails: true,
                              step: KeyStep(lead: String(localized: "서버 컴퓨터의 "), tail: String(localized: "에 \(kinds) 키를 더하고 서버를 다시 시작합니다.")))
        }
        return HostStatus(tone: .success, text: sending.isEmpty ? String(localized: "준비됨") : String(localized: "준비됨 · iPhone \(sending.count)대"), ready: true)
    }

    private var hostGroup: some View {
        let line = hostStatus
        let others = listedDevices
        #if os(iOS)
        let coverageHere = phone == nil
        #else
        let coverageHere = true
        #endif
        // Mac: the iPhone part under its own caption, below the Mac one.
        return SettingsGroup(isMac ? "iPhone" : nil, footnote: coverageHere ? Self.coverage : nil) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(isMac ? "iPhone 알림" : "서버 컴퓨터").font(SetupFont.row).foregroundStyle(CE.ink)
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        StatusDot(tone: line.tone, size: 7)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        Text(line.text).font(SetupFont.hint)
                            .foregroundStyle(line.tone == .attention ? CE.attention : CE.ink2)
                            .lineSpacing(SetupFont.hintLeading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .help(providerSummary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if line.hasDetails { detailsToggle }
                if !store.isDemo {
                    // Not disabled by the poll itself (it would blink every 10 seconds); a tap during it is a no-op.
                    SettingsRefreshButton(label: String(localized: "iPhone 알림 다시 확인"), busy: busy && manualRefresh) {
                        Task { manualRefresh = true; await refresh(); manualRefresh = false }
                    }
                    .disabled(!connected)
                }
            }
            .padding(.vertical, 12)
            .frame(minHeight: isMac ? 56 : 52)
            if let step = line.step {
                keyStep(step).padding(.bottom, 14)
            }
            if line.hasDetails && showDetails {
                details.padding(.bottom, 14)
            }
            if !store.pendingPushRevocations.isEmpty {
                InlineNotice(title: String(localized: "해지 미완료"), detail: String(localized: "이전에 연결한 서버에서 해지를 마치지 못했습니다. 그 서버에 다시 연결해 확인해 주세요."))
                    .padding(.bottom, 14)
            }
            ForEach(others) { device in
                RowDivider(inset: 0)
                PushDeviceRow(device: device, editable: connected).id("\(store.pushSettings.generation):\(device.id)")
            }
            if coverageHere, line.ready, devices.isEmpty {
                RowDivider(inset: 0)
                Text("iPhone 앱의 설정 › 알림에서 켜면 여기에 나옵니다.")
                    .font(SetupFont.hint).foregroundStyle(CE.ink2)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 14)
            }
        }
    }

    /// "서버 컴퓨터의 ~/.iamceo/apns.json에 …": the path in mono, the whole line selectable so it can be pasted.
    private func keyStep(_ step: KeyStep) -> some View {
        Text("\(step.lead)\(Text(Self.keyFile).font(CEFont.mono).foregroundStyle(CE.ink))\(step.tail)")
            .font(SetupFont.hint).foregroundStyle(CE.ink2)
            .lineSpacing(SetupFont.hintLeading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// web .gbtn--ghost: text only until hovered.
    private var detailsToggle: some View {
        Button { withAnimation(.snappy(duration: 0.22)) { showDetails.toggle() } } label: {
            HStack(spacing: 4) {
                Text("자세히")
                Image(systemName: showDetails ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .bold))
            }
        }
        .ceGhostButton()
        .controlSize(.mini)
        .fixedSize()
        .accessibilityLabel(showDetails ? "자세히 닫기" : "자세히 보기")
    }

    /// The provider per build kind, with the server's last error when it has one.
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array((status?.providers ?? []).enumerated()), id: \.offset) { _, provider in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 7) {
                        StatusDot(tone: provider.state == .ready ? .success : .attention, size: 7)
                        Text(environmentName(provider.environment)).foregroundStyle(CE.ink)
                        Spacer(minLength: 8)
                        Text(providerLabel(provider.state)).foregroundStyle(provider.state == .ready ? CE.ink2 : CE.attention)
                    }
                    .font(CEFont.secondary)
                    .accessibilityElement(children: .combine)
                    if let error = provider.lastError, !error.isEmpty {
                        Text(error).font(CEFont.mono).foregroundStyle(CE.ink2).lineLimit(2).textSelection(.enabled)
                            .ceLineHeight(12.5, 1.45)
                            .padding(.leading, 14)
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
    }

    /// Every provider in one line, for the status tooltip (the rows themselves show only when something is wrong).
    private var providerSummary: String {
        (status?.providers ?? []).map { "\(environmentName($0.environment)) \(providerLabel($0.state))" }.joined(separator: " · ")
    }

    private func environmentName(_ environment: PushEnvironment) -> String {
        switch environment {
        case .sandbox: String(localized: "개발 빌드용")
        case .production: String(localized: "배포 빌드용")
        case .unknown: String(localized: "알 수 없는 빌드")
        }
    }

    private func providerLabel(_ state: PushProviderState) -> String {
        switch state {
        case .ready: String(localized: "준비됨")
        case .unconfigured: String(localized: "푸시 키 없음")
        case .configurationError: String(localized: "푸시 키 오류")
        case .temporarilyUnavailable: String(localized: "잠시 사용할 수 없음")
        case .unknown: String(localized: "확인 필요")
        }
    }

    // MARK: This iPhone

    #if os(iOS)
    private func phoneGroup(_ phone: PhoneControl) -> some View {
        let state = phone.state
        let mine = devices.first { $0.id == phone.installationID }
        let on = pendingChoice ?? PhonePushSwitch.isOn(state, device: mine)
        let line = phoneLine(phone, mine: mine, on: on)
        let blocked = !connected || pendingChoice != nil || [.requestingPermission, .registering].contains(state)
        return SettingsGroup(String(localized: "이 iPhone"), footnote: Self.coverage) {
            SettingsRow(String(localized: "이 iPhone에서 알림 받기"), hint: line.text, hintTone: line.attention ? CE.attention : CE.ink2) {
                Toggle("이 iPhone에서 알림 받기", isOn: Binding(get: { on }, set: { turn($0, phone) }))
                    .labelsHidden()
                    .settingsSwitch()
                    .disabled(blocked)
            }
            if pendingChoice == nil, state == .denied || [.awaitingHost, .failed, .revocationPending].contains(state) {
                HStack(spacing: 8) {
                    if state == .denied {
                        Button("시스템 설정 열기") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .ceSecondaryButton()
                    } else {
                        Button("다시 확인") {
                            Task {
                                while busy { try? await Task.sleep(for: .milliseconds(100)) }
                                await phone.recheck()
                            }
                        }
                        .ceSecondaryButton()
                        .disabled(!connected)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 10)
            }
            if let mine {
                RowDivider(inset: 0)
                PushDeviceRow(device: mine, editable: connected, isThisDevice: true, showsPreferences: on)
                    .id("\(store.pushSettings.generation):\(mine.id)")
            }
        }
    }

    /// On always calls `enable()`, off always `disable()`; the poll's brief refresh only delays the tap.
    private func turn(_ on: Bool, _ phone: PhoneControl) {
        guard pendingChoice == nil else { return }
        lastChoice = on
        pendingChoice = on
        Task {
            while busy { try? await Task.sleep(for: .milliseconds(100)) }
            if on { await phone.enable() } else { await phone.disable() }
            pendingChoice = nil
        }
    }

    /// The line under the switch: what is happening, or why nothing arrives (attention colour).
    private func phoneLine(_ phone: PhoneControl, mine: PushDevice?, on: Bool) -> (text: String, attention: Bool) {
        if let pendingChoice { return (pendingChoice ? String(localized: "켜는 중") : String(localized: "끄는 중"), false) }
        switch phone.state {
        case .denied: return (String(localized: "iPhone 설정에서 알림이 꺼져 있습니다"), true)
        case .failed: return (lastChoice == false ? String(localized: "끄지 못했습니다. 다시 꺼 주세요.") : String(localized: "등록하지 못했습니다"), true)
        case .requiresOptIn: return (String(localized: "다시 켜야 받습니다"), true)
        case .revocationPending: return (String(localized: "이전 해지가 끝나지 않았습니다"), true)
        case .unsupported: return (String(localized: "이 iPhone에서는 알림을 쓸 수 없습니다"), true)
        case .needsHost: return (String(localized: "서버에 연결해야 켤 수 있습니다"), false)
        case .requestingPermission: return (String(localized: "알림 권한을 묻는 중"), false)
        case .registering: return (String(localized: "등록하는 중"), false)
        case .awaitingHost: return (String(localized: "서버 등록을 기다리는 중"), false)
        case .enabled, .disabled: break
        }
        if let blocker = serverBlocker(for: mine) { return (blocker, true) }
        if !on { return (phone.state == .enabled ? String(localized: "다른 기기에서 꺼 두었습니다") : String(localized: "꺼져 있습니다"), false) }
        var line = String(localized: "받는 중")
        if let settings = phone.systemSettings {
            line += String(localized: " · 배너 \(settings.alertsEnabled ? String(localized: "켬") : String(localized: "끔")) · 소리 \(settings.soundsEnabled ? String(localized: "켬") : String(localized: "끔"))")
        }
        return (line, false)
    }

    /// Why this iPhone cannot get anything from the server even with the switch on (nil while unknown or fine).
    private func serverBlocker(for mine: PushDevice?) -> String? {
        guard let status, !status.providers.isEmpty else { return nil }
        let ready = Set(status.providers.filter { $0.state == .ready }.map(\.environment))
        if ready.isEmpty { return String(localized: "서버에 푸시 키가 없어 지금은 받을 수 없습니다") }
        if let environment = mine?.environment, environment != .unknown, !ready.contains(environment) {
            return String(localized: "서버에 이 iPhone용 푸시 키가 없어 받을 수 없습니다")
        }
        return nil
    }
    #endif

    private func refresh() async {
        guard connected, !busy else { return }
        busy = true
        defer { busy = false }
        if store.pushSettings.host == nil { await store.refreshPushConnection() }
        let generation = store.pushSettings.generation
        guard store.pushSettings.host != nil, !Task.isCancelled else { return }
        do {
            try await store.pushSettings.refresh()
            guard generation == store.pushSettings.generation else { return }
            refreshError = nil
        } catch {
            guard generation == store.pushSettings.generation else { return }
            refreshError = pushSettingsError(error)
            if error as? PushSettingsError == .requestFailed(401) { await store.refresh() }
        }
    }
}

/// One registered iPhone: name and last contact, its own on/off and the four kinds it hears about; 시험 알림 and 해지 in
/// its menu. On the iPhone itself (its switch is above) the four kinds show while it is on, with 시험 알림 and 해지 as a
/// quiet line under them.
private struct PushDeviceRow: View {
    let device: PushDevice
    let editable: Bool
    var isThisDevice = false
    var showsPreferences = true
    @Environment(AppStore.self) private var store
    @State private var error: String?
    @State private var notice: String?
    @State private var working = false
    @State private var confirmRevoke = false
    private var enabled: Bool { editable && !working && !store.pushSettings.pendingDevices.contains(device.id) }
    private var name: String { device.label ?? "iPhone" }
    private var receiving: Bool { device.enabled == true && device.state == .active }
    private var canTest: Bool { enabled && receiving }

    var body: some View {
        VStack(alignment: .leading, spacing: isMac ? 10 : 0) {
            if isThisDevice {
                if showsPreferences { preferences }
                ownActions
            } else {
                header
                #if os(macOS)
                preferences
                #else
                if receiving { preferences.padding(.top, 4) }
                #endif
            }
            if let error { InlineNotice(tone: .attention, title: error).padding(.vertical, isMac ? 0 : 6) }
            if let notice {
                Text(notice).font(SetupFont.hint).foregroundStyle(CE.ink2)
                    .lineSpacing(SetupFont.hintLeading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, isMac ? 0 : 8)
            }
        }
        .padding(.vertical, isThisDevice ? 4 : 12)
        .confirmationDialog("이 기기의 알림 등록을 해지할까요?", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("해지", role: .destructive) {
                Task { await change {
                    if store.pushNotifications?.installationID == device.id { await store.pushNotifications?.revoke() }
                    else { try await store.pushSettings.revoke(id: device.id) }
                } }
            }
            Button("취소", role: .cancel) {}
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "iphone").font(.system(size: 16)).foregroundStyle(CE.ink2).frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(name).font(SetupFont.row).foregroundStyle(CE.ink).lineLimit(1)
                    if device.state != .active {
                        Tag(device.state == .revoked ? String(localized: "해지됨") : String(localized: "등록 확인 필요"), tone: .attention)
                    }
                }
                meta
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if working { ProgressView().controlSize(.small).accessibilityLabel("저장 중") }
            Toggle("\(name) 전체 알림", isOn: Binding(get: { device.enabled == true }, set: { value in
                Task { await change { _ = try await store.pushSettings.patch(id: device.id, enabled: value) } }
            }))
            .labelsHidden()
            .settingsSwitch()
            .disabled(!enabled || device.state != .active)
            .help("이 iPhone으로 보내기")
            Menu {
                Button("시험 알림 보내기") { sendTest() }.disabled(!canTest)
                Divider()
                Button("알림 등록 해지…", role: .destructive) { confirmRevoke = true }.disabled(!enabled)
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(CE.ink2)
                    .frame(width: 28, height: 28)
                    .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .help("시험 알림 · 해지")
            .accessibilityLabel("\(name) 관리")
        }
    }

    /// Last contact and last notification. iPhone: each part keeps its words together and the pair may wrap once.
    @ViewBuilder private var meta: some View {
        let parts = [
            relativeTime(device.lastSeenAt).isEmpty ? nil : String(localized: "최근 접속 \(relativeTime(device.lastSeenAt))"),
            relativeTime(device.lastAcceptedAt).isEmpty ? nil : String(localized: "마지막 알림 \(relativeTime(device.lastAcceptedAt))")
        ]
        #if os(macOS)
        MetaText(parts)
        #else
        Text(parts.compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }.joined(separator: " · "))
            .font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(2)
            .lineSpacing(CELeading.meta)
            .fixedSize(horizontal: false, vertical: true)
        #endif
    }

    /// This iPhone's 시험 알림 and 해지: two quiet text buttons (the switch above already turns it off).
    private var ownActions: some View {
        HStack(spacing: 22) {
            if receiving {
                Button("시험 알림 보내기") { sendTest() }
                    .foregroundStyle(canTest ? CE.accent : CE.ink3)
                    .disabled(!canTest)
            }
            Button("알림 등록 해지…") { confirmRevoke = true }
                .foregroundStyle(CE.ink3)
                .opacity(enabled ? 1 : 0.6)
                .disabled(!enabled)
            Spacer(minLength: 0)
            if working { ProgressView().controlSize(.small).accessibilityLabel("저장 중") }
        }
        .buttonStyle(.plain)
        .font(SetupFont.hint.weight(.medium))
        .frame(minHeight: isMac ? 30 : 44)
    }

    /// Mac: four checkboxes on one line under a quiet "받을 알림" label, lined up with the name. iPhone: a switch row each.
    @ViewBuilder private var preferences: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 6) {
            Text("받을 알림").font(CEFont.meta).foregroundStyle(CE.ink3)
                .accessibilityHidden(true)
            HStack(spacing: 18) { preferenceToggles }
                .toggleStyle(.checkbox)
                .tint(CE.violet)
                .font(CEFont.secondary)
                .foregroundStyle(CE.ink2)
        }
        .padding(.leading, isThisDevice ? 0 : 30)
        #else
        VStack(alignment: .leading, spacing: 0) { preferenceToggles }
            .settingsSwitch()
            .font(SetupFont.row)
            .foregroundStyle(CE.ink)
        #endif
    }

    @ViewBuilder private var preferenceToggles: some View {
        preference(String(localized: "새 결재"), value: device.preferences?.decision, patch: { PushPreferencesPatch(decision: $0) })
        preference(String(localized: "승인 창 앞 멈춤"), value: device.preferences?.approvalWait, patch: { PushPreferencesPatch(approvalWait: $0) })
        preference(String(localized: "오류 멈춤"), value: device.preferences?.error, patch: { PushPreferencesPatch(error: $0) })
        preference(String(localized: "완료 보고"), value: device.preferences?.reportComplete, patch: { PushPreferencesPatch(reportComplete: $0) })
        preference(String(localized: "대표 할 일 생김"), value: device.preferences?.todoCreated, patch: { PushPreferencesPatch(todoCreated: $0) })
        preference(String(localized: "막힘 보고"), value: device.preferences?.reportBlocked, patch: { PushPreferencesPatch(reportBlocked: $0) })
    }

    private func preference(_ title: String, value: Bool?, patch: @escaping (Bool) -> PushPreferencesPatch) -> some View {
        Toggle(title, isOn: Binding(get: { value == true }, set: { value in
            Task { await change { _ = try await store.pushSettings.patch(id: device.id, preferences: patch(value)) } }
        }))
        .disabled(!enabled || device.preferences == nil || device.state != .active)
        .frame(minHeight: isMac ? nil : 44)
        .accessibilityLabel("\(name) \(title) 알림")
    }

    private func sendTest() {
        Task { await change {
            let result = try await store.pushSettings.sendTest(id: device.id, requestID: UUID().uuidString.lowercased())
            notice = result.state == .accepted ? String(localized: "시험 알림을 보냈습니다. iPhone에서 확인해 주세요.") : String(localized: "시험 알림을 요청했습니다. iPhone에서 확인해 주세요.")
        } }
    }

    private func change(_ operation: () async throws -> Void) async {
        guard enabled else { return }
        guard store.pushSettings.device(id: device.id)?.revision == device.revision else {
            error = pushSettingsError(PushSettingsError.conflict)
            return
        }
        let generation = store.pushSettings.generation
        working = true; error = nil; notice = nil
        defer { working = false }
        do { try await operation() }
        catch {
            guard generation == store.pushSettings.generation else { return }
            self.error = pushSettingsError(error)
            if error as? PushSettingsError == .conflict { try? await store.pushSettings.refresh() }
            if error as? PushSettingsError == .requestFailed(401) { await store.refresh() }
        }
    }
}

private func pushSettingsError(_ error: any Error) -> String {
    switch error as? PushSettingsError {
    case .conflict: String(localized: "다른 기기에서 설정이 바뀌었습니다. 새 설정을 확인해 주세요.")
    case .unsupported: String(localized: "이 서버는 iPhone 알림을 지원하지 않습니다.")
    case .hostChanged: String(localized: "연결한 서버가 바뀌었습니다.")
    case .busy: String(localized: "이 기기의 변경을 처리하고 있습니다.")
    default: String(localized: "알림 설정을 확인하지 못했습니다. 다시 확인해 주세요.")
    }
}
