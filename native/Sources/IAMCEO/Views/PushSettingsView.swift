import SwiftUI
#if os(iOS)
import UIKit
#endif

struct PushSettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var refreshError: String?
    @State private var busy = false

    var body: some View {
        Plate {
            VStack(alignment: .leading, spacing: CESpace.m) {
                HStack {
                    Text("iPhone 알림").font(CEFont.title).foregroundStyle(CE.ink)
                    Spacer()
                    Button("다시 확인") { Task { await refresh() } }.ceSecondaryButton().ceCompactControl()
                        .disabled(!connected || busy)
                }
                Text("새 결재·승인 창 앞 멈춤·오류 멈춤·완료 보고를 알립니다. 완료 보고는 같은 프로젝트·직원별로 2분 동안 묶습니다.")
                    .font(CEFont.secondary).foregroundStyle(CE.ink2)
                if store.isDemo { Text("샘플은 읽기 전용입니다").font(CEFont.meta).foregroundStyle(CE.ink3) }
                if store.pushConnectionError == .unsupported {
                    InlineNotice(title: "이 호스트는 iPhone 알림을 지원하지 않습니다")
                } else if let error = refreshError {
                    InlineNotice(tone: .attention, title: error)
                }
                if let status = store.pushSettings.status {
                    ForEach(Array(status.providers.enumerated()), id: \.offset) { _, provider in
                        HStack {
                            StatusDot(tone: provider.state == .ready ? .success : .attention)
                            Text(provider.environment == .sandbox ? "개발 알림" : provider.environment == .production ? "배포 알림" : "알 수 없는 환경")
                            Spacer()
                            Text(providerLabel(provider.state))
                        }.font(CEFont.meta).foregroundStyle(CE.ink2)
                    }
                }
                #if os(iOS)
                if let service = store.pushNotifications {
                    VStack(alignment: .leading, spacing: CESpace.s) {
                        Text(registrationLabel(service.state)).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                        if let settings = service.systemSettings {
                            Text("배너 \(settings.alertsEnabled ? "켜짐" : "꺼짐") · 소리 \(settings.soundsEnabled ? "켜짐" : "꺼짐")")
                                .font(CEFont.meta).foregroundStyle(CE.ink3)
                        }
                        HStack {
                            Button("이 iPhone 알림 켜기") { Task { await service.enable() } }.ceSecondaryButton()
                            Button("끄기") { Task { await service.disable() } }.ceSecondaryButton()
                            if service.state == .awaitingHost || service.state == .failed || service.state == .revocationPending {
                                Button("등록 다시 확인") { Task { await service.foreground() } }.ceSecondaryButton()
                            }
                            if service.state == .denied {
                                Button("시스템 설정") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }.ceSecondaryButton()
                            }
                        }.disabled(!connected || busy || [.requestingPermission, .registering].contains(service.state))
                    }
                }
                #endif
                ForEach(store.pushSettings.devices) { device in
                    RowDivider(inset: 0)
                    PushDeviceRow(device: device, editable: connected).id("\(store.pushSettings.generation):\(device.id)")
                }
                if store.pushSettings.devices.isEmpty, !busy, store.pushSettings.status != nil {
                    Text("등록한 iPhone이 없습니다").font(CEFont.meta).foregroundStyle(CE.ink3)
                }
                if !store.pendingPushRevocations.isEmpty {
                    InlineNotice(title: "해지 미완료", detail: "이전에 연결한 호스트에서 해지를 마치지 못했습니다. 해당 호스트에 다시 연결해 확인해 주세요.")
                }
                Text("푸시 키는 호스트에서 설정합니다. 알림 접수는 기기 수신 확인이 아닙니다.")
                    .font(CEFont.meta).foregroundStyle(CE.ink3)
            }
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
    private func providerLabel(_ state: PushProviderState) -> String {
        switch state {
        case .ready: "준비됨"
        case .unconfigured: "호스트 설정 필요"
        case .configurationError: "호스트 설정 오류"
        case .temporarilyUnavailable: "잠시 사용할 수 없음"
        case .unknown: "상태 확인 필요"
        }
    }
    private func registrationLabel(_ state: PushRegistrationState) -> String {
        switch state {
        case .disabled: "이 iPhone 알림 꺼짐"
        case .needsHost: "호스트 연결 필요"
        case .requestingPermission: "알림 권한 확인 중"
        case .denied: "시스템 설정에서 알림을 허용해 주세요"
        case .registering: "등록 중"
        case .awaitingHost: "허용됨 · 호스트 등록 대기"
        case .enabled: "수신 설정 켜짐"
        case .requiresOptIn: "다시 켜려면 확인이 필요합니다"
        case .revocationPending: "해지 미완료"
        case .unsupported: "알림 환경을 확인해 주세요"
        case .failed: "등록하지 못했습니다"
        }
    }
}

private struct PushDeviceRow: View {
    let device: PushDevice
    let editable: Bool
    @Environment(AppStore.self) private var store
    @State private var error: String?
    @State private var notice: String?
    @State private var working = false
    @State private var confirmRevoke = false
    private var enabled: Bool { editable && !working && !store.pushSettings.pendingDevices.contains(device.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: CESpace.s) {
            HStack {
                Text(device.label ?? "iPhone").font(CEFont.rowTitle).foregroundStyle(CE.ink)
                Spacer()
                if working { ProgressView().controlSize(.small).accessibilityLabel("저장 중") }
                Tag(device.state == .active ? "등록됨" : device.state == .revoked ? "해지됨" : "등록 확인 필요")
            }
            Text("최근 접속 \(relativeTime(device.lastSeenAt)) · 알림 접수 \(relativeTime(device.lastAcceptedAt))")
                .font(CEFont.meta).foregroundStyle(CE.ink3)
            Toggle("전체 알림", isOn: Binding(get: { device.enabled == true }, set: { value in
                Task { await change { _ = try await store.pushSettings.patch(id: device.id, enabled: value) } }
            })).disabled(!enabled || device.state != .active)
            preference("새 결재", value: device.preferences?.decision, patch: { PushPreferencesPatch(decision: $0) })
            preference("승인 창 앞 멈춤", value: device.preferences?.approvalWait, patch: { PushPreferencesPatch(approvalWait: $0) })
            preference("오류 멈춤", value: device.preferences?.error, patch: { PushPreferencesPatch(error: $0) })
            preference("완료 보고", value: device.preferences?.reportComplete, patch: { PushPreferencesPatch(reportComplete: $0) })
            HStack {
                Button("시험 알림") {
                    Task { await change {
                        let result = try await store.pushSettings.sendTest(id: device.id, requestID: UUID().uuidString.lowercased())
                        notice = result.state == .accepted ? "APNs에 접수했습니다. 기기 수신은 별도로 확인해 주세요." : "시험 알림을 요청했습니다. 기기에서 확인해 주세요."
                    } }
                }.ceSecondaryButton().disabled(!enabled || device.enabled != true || device.state != .active)
                Button("해지…") { confirmRevoke = true }.ceSecondaryButton().disabled(!enabled)
            }
            if let error { InlineNotice(tone: .attention, title: error) }
            if let notice { Text(notice).font(CEFont.meta).foregroundStyle(CE.ink2) }
        }
        .font(CEFont.secondary).foregroundStyle(CE.ink2)
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
    private func preference(_ title: String, value: Bool?, patch: @escaping (Bool) -> PushPreferencesPatch) -> some View {
        Toggle(title, isOn: Binding(get: { value == true }, set: { value in
            Task { await change { _ = try await store.pushSettings.patch(id: device.id, preferences: patch(value)) } }
        })).disabled(!enabled || device.preferences == nil || device.state != .active)
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
    case .conflict: "다른 기기에서 설정이 바뀌었습니다. 새 설정을 확인해 주세요."
    case .unsupported: "이 호스트는 iPhone 알림을 지원하지 않습니다."
    case .hostChanged: "연결한 호스트가 바뀌었습니다."
    case .busy: "이 기기의 변경을 처리하고 있습니다."
    default: "알림 설정을 확인하지 못했습니다. 다시 확인해 주세요."
    }
}
