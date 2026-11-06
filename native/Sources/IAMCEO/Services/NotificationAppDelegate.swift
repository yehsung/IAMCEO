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
