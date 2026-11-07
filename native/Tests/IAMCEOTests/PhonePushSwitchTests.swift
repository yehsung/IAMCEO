import XCTest
@testable import IAMCEO

/// The "이 iPhone에서 알림 받기" switch must never show off while notifications can still arrive, because switching it
/// off is the only way to reach `disable()` there.
final class PhonePushSwitchTests: XCTestCase {
    private let states: [PushRegistrationState] = [
        .disabled, .needsHost, .requestingPermission, .denied, .registering, .awaitingHost,
        .enabled, .requiresOptIn, .revocationPending, .unsupported, .failed
    ]

    private func device(enabled: Bool?, state: PushDeviceState?) -> PushDevice {
        PushDevice(id: "this-iphone", environment: .production, enabled: enabled, state: state)
    }

    func testOnWheneverTheServerSendsToThisIPhone() {
        let sending = device(enabled: true, state: .active)
        for state in states {
            XCTAssertTrue(PhonePushSwitch.isOn(state, device: sending), "\(state) hides a device the server still sends to")
        }
    }

    func testOnAfterTheOwnerTurnedItOnEvenWhenNothingArrives() {
        // A temporary network error (.failed) or a refused permission (.denied) keeps the owner's choice, so off still works.
        for state in [PushRegistrationState.failed, .denied, .requestingPermission, .registering, .awaitingHost] {
            XCTAssertTrue(PhonePushSwitch.isOn(state, device: nil))
            XCTAssertTrue(PhonePushSwitch.isOn(state, device: device(enabled: false, state: .active)))
        }
        XCTAssertTrue(PhonePushSwitch.isOn(.enabled, device: nil), "trusts the service before the device list loads")
    }

    func testOffWhenAnotherDeviceTurnedThisIPhoneOffOrItWasRevoked() {
        XCTAssertFalse(PhonePushSwitch.isOn(.enabled, device: device(enabled: false, state: .active)))
        XCTAssertFalse(PhonePushSwitch.isOn(.enabled, device: device(enabled: true, state: .revoked)))
        for state in [PushRegistrationState.disabled, .needsHost, .requiresOptIn, .revocationPending, .unsupported] {
            XCTAssertFalse(PhonePushSwitch.isOn(state, device: nil))
            XCTAssertFalse(PhonePushSwitch.isOn(state, device: device(enabled: false, state: .active)))
            XCTAssertFalse(PhonePushSwitch.isOn(state, device: device(enabled: true, state: .revoked)))
        }
    }
}
