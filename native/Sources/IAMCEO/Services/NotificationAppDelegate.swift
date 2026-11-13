#if os(iOS)
import UIKit
import UserNotifications

@MainActor
final class SystemPushAuthorizationProvider: PushAuthorizationProvider {
    static let shared = SystemPushAuthorizationProvider()
    var onToken: (@MainActor @Sendable (Data, UUID) -> Void)?
    var onFailure: (@MainActor @Sendable (UUID) -> Void)?
    private var pending: UUID?
    private var queued: UUID?

    func settings() async -> PushSystemSettings {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let authorization: PushAuthorization
        switch settings.authorizationStatus {
        case .authorized: authorization = .authorized
        case .provisional: authorization = .provisional
        case .ephemeral: authorization = .ephemeral
        case .denied: authorization = .denied
        case .notDetermined: authorization = .notDetermined
        @unknown default: authorization = .unknown
        }
        return PushSystemSettings(authorization: authorization, alertsEnabled: settings.alertSetting == .enabled,
                                  soundsEnabled: settings.soundSetting == .enabled)
    }
    func requestAuthorization() async throws {
        _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }
    func offerNotificationSetup() async -> Bool? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              let root = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return nil }
        var presenter = root
        while let next = presenter.presentedViewController { presenter = next }
        guard presenter.viewIfLoaded?.window != nil, !presenter.isBeingDismissed,
              !(presenter is UIAlertController) else { return nil }
        return await withCheckedContinuation { continuation in
            // 버튼 없이 닫히면 어느 핸들러도 불리지 않는다. 그때는 choice 가 풀리며 nil 로 끝낸다.
            let choice = PendingSetupChoice(continuation)
            let alert = UIAlertController(title: String(localized: "iPhone 알림을 켤까요?"), message: nil, preferredStyle: .alert)
            alert.message = String(localized: "새 결재와 승인 대기, 완료·막힘 보고, 대표 할 일을 알려 드립니다. 설정에서 언제든 바꿀 수 있습니다.")
            alert.addAction(UIAlertAction(title: String(localized: "지금 켜기"), style: .default) { _ in choice.resolve(true) })
            alert.addAction(UIAlertAction(title: String(localized: "나중에"), style: .cancel) { _ in choice.resolve(false) })
            presenter.present(alert, animated: true)
        }
    }
    func register(generation: UUID) -> Bool {
        if let pending {
            if pending != generation { queued = generation }
            return true
        }
        pending = generation
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }
    // Keep the old ticket until its callback: UIKit supplies no correlation identifier.
    func cancelPendingRegistration() { queued = nil }
    func clearDelivered(serverID: String) async {
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let ids = delivered.filter {
            NotificationLink.parse(payload: $0.request.content.userInfo)?.serverID == serverID.lowercased()
        }.map(\.request.identifier)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
    func didRegister(_ data: Data) {
        guard let id = pending else { return }
        pending = nil
        onToken?(data, id)
        registerQueued()
    }
    func didFail() {
        guard let id = pending else { return }
        pending = nil
        onFailure?(id)
        registerQueued()
    }
    private func registerQueued() {
        guard let id = queued else { return }
        queued = nil
        _ = register(generation: id)
    }
}

@MainActor
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        SystemPushAuthorizationProvider.shared.didRegister(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // Do not forward arbitrary NSError descriptions (they may contain token/request details).
        SystemPushAuthorizationProvider.shared.didFail()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let link = NotificationLink.parse(payload: notification.request.content.userInfo)
        completionHandler([])
        if let link { Task { @MainActor in NotificationInbox.shared.receive(link, tapped: false) } }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = response.actionIdentifier == UNNotificationDefaultActionIdentifier
            ? NotificationLink.parse(payload: response.notification.request.content.userInfo) : nil
        completionHandler()
        if let link { Task { @MainActor in NotificationInbox.shared.receive(link, tapped: true) } }
    }
}
#endif
